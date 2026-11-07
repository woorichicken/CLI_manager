import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhoneServer } from '../../src/main/phone/PhoneServer'
import {
    DOCK_ANSWER_TIMEOUT_MS,
    DOCK_MAX_RESPONSE_BYTES,
    DOCK_MAX_ROWS,
    DOCK_MAX_TITLE,
    DOCK_OUTDATED_HOLD_MS,
    DOCK_REQUEST,
    DOCK_REUSE_MS,
    PhoneDock,
    dockHostFiles,
    dockItemKey,
    dockLocation
} from '../../src/main/phone/phoneDock'
import { PHONE_API, type PhoneDockResponse, type PhoneMe } from '../../src/shared/phone'

/**
 * T99 — the phone's Dock list without Electron: a real unix socket on the far side.
 *
 * The extension owns the order; main only reads, checks and passes it on. What matters here: the four
 * answers a phone can get, that nothing but one fixed request ever reaches the socket, that a dead or
 * old extension is not asked again and again, what main refuses to pass on, and the phone server's gate.
 */

const FILE_URL = (name: string): string => `file:///Users/me/work/${name}.html`
const row = (name: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    key: `file:/Users/me/work/${name}.html`,
    url: FILE_URL(name),
    title: name,
    sub: '~/work',
    at: 100,
    pinned: false,
    missing: false,
    ...extra
})
const listReply = (open: unknown[] = [], closed: unknown[] = [], extra: Record<string, unknown> = {}): string =>
    `${JSON.stringify({ id: 'x', ok: true, protocol: 1, extVersion: '0.7.0', missingSupported: true, open, closed, ...extra })}\n`

interface FakeSocket {
    file: string
    connections: () => number
    received: () => string[]
    answer: (reply: string | null) => void
    close: () => Promise<void>
}

/** The other end of `dock.sock`. `answer(null)` takes the request and never replies, as an old extension does for 8 s. */
async function fakeSocket(first: string | null): Promise<FakeSocket> {
    // unix socket paths are limited to 104 bytes on macOS
    const file = path.join('/tmp', `t99-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`)
    let reply = first
    let connections = 0
    const received: string[] = []
    const open = new Set<net.Socket>()
    const server = net.createServer((socket) => {
        connections++
        open.add(socket)
        socket.on('close', () => open.delete(socket))
        socket.on('error', () => undefined)
        socket.on('data', (chunk) => {
            received.push(chunk.toString('utf8'))
            if (reply !== null) socket.write(reply)
        })
    })
    await new Promise<void>((resolve) => server.listen(file, resolve))
    return {
        file,
        connections: () => connections,
        received: () => received,
        answer: (next) => {
            reply = next
        },
        close: () =>
            new Promise((resolve) => {
                for (const socket of open) socket.destroy()
                server.close(() => resolve())
            })
    }
}

function dockFor(socketPath: string | null, options: { names?: Record<string, string>; clock?: { now: number }; mask?: (text: string) => string } = {}): PhoneDock {
    const clock = options.clock
    return new PhoneDock({
        socketPath,
        assumeInstalled: socketPath !== null,
        hostFiles: [],
        sessionName: (id) => options.names?.[id] ?? null,
        maskLine: options.mask ?? ((text) => text),
        ...(clock ? { now: () => clock.now } : {})
    })
}

const read = async (dock: PhoneDock): Promise<PhoneDockResponse> => {
    const response = await dock.read()
    expect(response).not.toBeNull()
    return response!
}

test.describe('T99 phone Dock — what comes back', () => {
    test('rows come in the order received, never re-sorted; kinds and addresses', async () => {
        // deliberately not newest first and with a pinned row last: a sort anywhere would change this
        const open = [row('middle', { at: 50 }), row('newest', { at: 900 }), row('oldest', { at: 1 }), row('pinned-last', { at: 2, pinned: true })]
        const closed = [
            row('gone', { missing: true, at: 7 }),
            { ...row('artifact', { at: 8 }), key: 'artifact:abc', url: 'https://claude.ai/code/artifact/abc?via=x', sub: 'Claude 아티팩트' }
        ]
        const socket = await fakeSocket(listReply(open, closed))
        try {
            const response = await read(dockFor(socket.file))
            expect(response.status).toBe('live')
            expect(response.asOf).not.toBeNull()
            expect(response.open.map((r) => r.title)).toEqual(['middle', 'newest', 'oldest', 'pinned-last'])
            expect(response.closed.map((r) => r.title)).toEqual(['gone', 'artifact'])
            expect(response.open[3].pinned).toBe(true)
            expect(response.closed[0].missing).toBe(true)
            // a file's absolute path never leaves the Mac
            expect(response.open[0].kind).toBe('file')
            expect('url' in response.open[0]).toBe(false)
            expect(JSON.stringify(response)).not.toContain('/Users/me')
            expect(response.closed[1].kind).toBe('link')
            expect(response.closed[1].url).toBe('https://claude.ai/code/artifact/abc?via=x')
        } finally {
            await socket.close()
        }
    })

    test('only the one fixed request ever reaches the socket', async () => {
        const socket = await fakeSocket(listReply([row('a')]))
        try {
            await read(dockFor(socket.file))
            expect(socket.received()).toEqual([DOCK_REQUEST])
            expect(DOCK_REQUEST).toBe('{"cmd":"list","v":1}\n')
        } finally {
            await socket.close()
        }
    })

    test('a session id becomes the session\'s name now; a closed session is marked gone', async () => {
        const names: Record<string, string> = { live: 'AI: fb-1106' }
        const socket = await fakeSocket(listReply([row('a', { sessionId: 'live' }), row('b', { sessionId: 'closed-one' }), row('c')]))
        try {
            const dock = dockFor(socket.file, { names })
            const response = await read(dock)
            expect(response.open[0].session).toEqual({ id: 'live', name: 'AI: fb-1106' })
            expect('sessionGone' in response.open[0]).toBe(false)
            expect(response.open[1].session).toBeNull()
            expect(response.open[1].sessionGone).toBe(true)
            expect(response.open[2].session).toBeNull()
            expect('sessionGone' in response.open[2]).toBe(false)
        } finally {
            await socket.close()
        }
    })

    test('titles and folders are masked and cut; rows are capped; a bad row is dropped, not fatal', async () => {
        const rows = Array.from({ length: DOCK_MAX_ROWS + 20 }, (_, index) => row(`r${index}`))
        const long = 'x'.repeat(DOCK_MAX_TITLE + 50)
        const bad = [
            { ...row('no-key'), key: undefined },
            { ...row('number-title'), title: 7 },
            { ...row('no-url'), url: 5 },
            'not an object',
            null
        ]
        const socket = await fakeSocket(listReply([row('secret', { title: 'token sk-LIVE', sub: '~/sk-LIVE' }), ...bad, { ...row('long'), title: long }], rows))
        try {
            const response = await read(dockFor(socket.file, { mask: (text) => text.split('sk-LIVE').join('***') }))
            expect(response.open.map((r) => r.key)).toEqual([dockItemKey(row('secret').key as string), dockItemKey(row('long').key as string)])
            expect(response.open[0].title).toBe('token ***')
            expect(response.open[0].sub).toBe('~/***')
            expect(response.open[1].title.length).toBe(DOCK_MAX_TITLE)
            expect(response.closed.length).toBe(DOCK_MAX_ROWS)
        } finally {
            await socket.close()
        }
    })

    test('a link is only https on claude.ai or claude.site; anything else has no address', async () => {
        const link = (key: string, url: string): Record<string, unknown> => ({ ...row(key), key, url })
        const socket = await fakeSocket(
            listReply([
                link('ok-ai', 'https://claude.ai/public/artifacts/1'),
                link('ok-site', 'https://claude.site/artifacts/2'),
                link('ok-sub', 'https://x.claude.ai/artifacts/3'),
                link('http', 'http://claude.ai/artifacts/4'),
                link('lookalike', 'https://claude.ai.evil.example/artifacts/5'),
                link('script', 'javascript:alert(1)'),
                link('other', 'https://example.com/a')
            ])
        )
        try {
            const response = await read(dockFor(socket.file))
            expect(response.open.map((r) => r.url ?? null)).toEqual([
                'https://claude.ai/public/artifacts/1',
                'https://claude.site/artifacts/2',
                'https://x.claude.ai/artifacts/3',
                null,
                null,
                null,
                null
            ])
            expect(response.open.every((r) => r.kind === 'link')).toBe(true)
        } finally {
            await socket.close()
        }
    })
})

test.describe('T99 phone Dock — when the extension is not answering', () => {
    test('Chrome off: no socket file, then a socket file nobody listens on', async () => {
        const missing = path.join('/tmp', `t99-none-${process.pid}.sock`)
        const off = await read(dockFor(missing))
        expect(off).toEqual({ status: 'chrome_off', asOf: null, open: [], closed: [] })

        // a crash leaves the file behind: renamed away while the listener closes, so it survives its close()
        const socket = await fakeSocket(listReply())
        const stale = `${socket.file}.stale`
        fs.renameSync(socket.file, stale)
        await socket.close()
        fs.renameSync(stale, socket.file)
        try {
            expect(fs.lstatSync(socket.file).isSocket()).toBe(true)
            expect((await read(dockFor(socket.file))).status).toBe('chrome_off')
        } finally {
            fs.rmSync(socket.file, { force: true })
        }
    })

    test('Chrome goes off: the last list stays, with the time it was read', async () => {
        const clock = { now: 1_000_000 }
        const socket = await fakeSocket(listReply([row('kept')]))
        const dock = dockFor(socket.file, { clock })
        const live = await read(dock)
        expect(live.asOf).toBe(1_000_000)
        await socket.close()
        clock.now += DOCK_REUSE_MS + 1
        const off = await read(dock)
        expect(off.status).toBe('chrome_off')
        expect(off.asOf).toBe(1_000_000)
        expect(off.open.map((r) => r.title)).toEqual(['kept'])
    })

    test('no answer is an older extension: cut at 2.5 s, not asked again for 30 s', async () => {
        const clock = { now: 5_000_000 }
        const socket = await fakeSocket(null)
        try {
            const dock = dockFor(socket.file, { clock })
            const started = Date.now()
            expect((await read(dock)).status).toBe('outdated')
            const took = Date.now() - started
            expect(took).toBeGreaterThanOrEqual(DOCK_ANSWER_TIMEOUT_MS - 50)
            expect(took).toBeLessThan(DOCK_ANSWER_TIMEOUT_MS + 1500)
            expect(socket.connections()).toBe(1)

            for (let i = 0; i < 5; i++) {
                clock.now += 5000
                expect((await read(dock)).status).toBe('outdated')
            }
            expect(socket.connections(), 'no new connection inside the hold').toBe(1)

            socket.answer(listReply([row('updated')]))
            clock.now += DOCK_OUTDATED_HOLD_MS
            const back = await read(dock)
            expect(back.status).toBe('live')
            expect(back.open.map((r) => r.title)).toEqual(['updated'])
            expect(socket.connections()).toBe(2)
        } finally {
            await socket.close()
        }
    })

    test('ok:false and another protocol also read as outdated', async () => {
        for (const reply of [`${JSON.stringify({ ok: false, error: 'no answer' })}\n`, listReply([row('a')], [], { protocol: 2 }), listReply([row('a')], [], { protocol: undefined })]) {
            const socket = await fakeSocket(reply)
            try {
                expect((await read(dockFor(socket.file))).status).toBe('outdated')
            } finally {
                await socket.close()
            }
        }
    })

    test('a broken answer is an error and keeps the last list', async () => {
        const clock = { now: 7_000_000 }
        const socket = await fakeSocket(listReply([row('kept')]))
        try {
            const dock = dockFor(socket.file, { clock })
            await read(dock)
            for (const broken of ['{not json\n', '[1,2]\n', listReply('nope' as never), `{"ok":true,"protocol":1,"open":[],"closed":{}}\n`]) {
                socket.answer(broken)
                clock.now += DOCK_REUSE_MS + 1
                const response = await read(dock)
                expect(response.status, broken).toBe('error')
                expect(response.open.map((r) => r.title)).toEqual(['kept'])
                expect(response.asOf).toBe(7_000_000)
            }
        } finally {
            await socket.close()
        }
    })

    test('an answer over the limit is an error and the connection is dropped', async () => {
        const socket = await fakeSocket(`${'x'.repeat(DOCK_MAX_RESPONSE_BYTES + 10)}`)
        try {
            expect((await read(dockFor(socket.file))).status).toBe('error')
        } finally {
            await socket.close()
        }
    })

    test('five requests at once are one connection; within a second the answer is reused', async () => {
        const clock = { now: 9_000_000 }
        const socket = await fakeSocket(listReply([row('a')]))
        try {
            const dock = dockFor(socket.file, { clock })
            const answers = await Promise.all(Array.from({ length: 5 }, () => read(dock)))
            expect(answers.every((a) => a.status === 'live')).toBe(true)
            expect(socket.connections()).toBe(1)
            clock.now += DOCK_REUSE_MS - 1
            await read(dock)
            expect(socket.connections()).toBe(1)
            clock.now += 2
            await read(dock)
            expect(socket.connections()).toBe(2)
        } finally {
            await socket.close()
        }
    })
})

test.describe('T99 phone Dock — where the socket is, and whether there is a Dock', () => {
    const home = '/Users/someone'

    test('tests never open the real socket; the env names a test socket', () => {
        expect(dockLocation({ CLIMANGER_TEST_USERDATA: '/tmp/x' }, 'darwin', home).socketPath).toBeNull()
        expect(dockLocation({ CLIMANGER_TEST_USERDATA: '/tmp/x', ARTIFACT_DOCK_SOCKET: '/tmp/d.sock' }, 'darwin', home)).toEqual({ socketPath: '/tmp/d.sock', assumeInstalled: true })
        expect(dockLocation({}, 'darwin', home)).toEqual({ socketPath: `${home}/Library/Application Support/ArtifactDock/dock.sock`, assumeInstalled: false })
        expect(dockLocation({}, 'linux', home).socketPath).toBeNull()
    })

    test('installed = a host registration or the socket exists', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't99-host-'))
        const registration = path.join(dir, 'dev.artifactdock.host.json')
        const socketFile = path.join(dir, 'none.sock')
        const dock = new PhoneDock({ socketPath: socketFile, assumeInstalled: false, hostFiles: [registration], sessionName: () => null, maskLine: (t) => t })
        expect(dock.installed()).toBe(false)
        expect(await dock.read()).toBeNull()
        fs.writeFileSync(registration, '{}')
        expect(dock.installed()).toBe(true)
        expect((await read(dock)).status).toBe('chrome_off')
        fs.rmSync(dir, { recursive: true, force: true })
        expect(new PhoneDock({ socketPath: null, assumeInstalled: false, hostFiles: [], sessionName: () => null, maskLine: (t) => t }).installed()).toBe(false)
        expect(dockHostFiles(home)).toEqual([
            `${home}/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.artifactdock.host.json`,
            `${home}/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts/dev.artifactdock.host.json`,
            `${home}/Library/Application Support/Chromium/NativeMessagingHosts/dev.artifactdock.host.json`,
            `${home}/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/dev.artifactdock.host.json`,
            `${home}/Library/Application Support/Microsoft Edge/NativeMessagingHosts/dev.artifactdock.host.json`
        ])
    })
})

test.describe('T99 phone Dock — what opens from a row (dockDocFor)', () => {
    const rows = [
        row('report'),
        row('한글 보고서', { key: 'file:/Users/me/한글 보고서.html', url: 'file:///Users/me/%ED%95%9C%EA%B8%80%20%EB%B3%B4%EA%B3%A0%EC%84%9C.html' }),
        row('owned', { sessionId: 's1', key: 'title:owned' }),
        row('xhtml', { key: 'k-xhtml', url: 'file:///a/b.xhtml' }),
        row('deleted', { key: 'k-deleted', missing: true }),
        row('env', { key: 'k-env', url: 'file:///Users/me/.env' }),
        row('ssh', { key: 'k-ssh', url: 'file:///Users/me/.ssh/id_rsa' }),
        row('climb', { key: 'k-climb', url: 'file:///Users/me/a%2F..%2F..%2F.ssh%2Fid.html' }),
        { ...row('link'), key: 'k-link', url: 'https://claude.ai/code/artifact/1' },
        { ...row('evil'), key: 'k-evil', url: 'https://evil.example/a.html' }
    ]

    test('a key from the list opens that file or link; nothing else does', async () => {
        const socket = await fakeSocket(listReply(rows))
        try {
            const dock = dockFor(socket.file, { names: { s1: 'Session one' } })
            expect(dock.docFor(dockItemKey(row('report').key as string)), 'before any read').toBeNull()
            await read(dock)
            expect(dock.docFor(dockItemKey(row('report').key as string))).toEqual({ kind: 'file', path: '/Users/me/work/report.html', session: null })
            expect(dock.docFor(dockItemKey('file:/Users/me/한글 보고서.html'))).toEqual({ kind: 'file', path: '/Users/me/한글 보고서.html', session: null })
            expect(dock.docFor(dockItemKey('title:owned'))).toEqual({ kind: 'file', path: '/Users/me/work/owned.html', session: { id: 's1', name: 'Session one' } })
            expect(dock.docFor(dockItemKey('k-xhtml'))).toEqual({ kind: 'file', path: '/a/b.xhtml', session: null })
            expect(dock.docFor(dockItemKey('k-link'))).toEqual({ kind: 'link', url: 'https://claude.ai/code/artifact/1' })
            for (const refused of ['k-deleted', 'k-env', 'k-ssh', 'k-climb', 'k-evil']) {
                expect(dock.docFor(dockItemKey(refused)), refused).toBeNull()
            }
            // a key the list never gave, or the extension's own key with the path in it, opens nothing
            for (const refused of [row('report').key as string, dockItemKey('file:/etc/passwd'), 'file:/etc/passwd', '../../etc/passwd', '']) {
                expect(dock.docFor(refused), refused).toBeNull()
            }
        } finally {
            await socket.close()
        }
    })
})

test.describe('T99 phone Dock — the phone server\'s gate', () => {
    async function start(reply: string | null, withDock = true) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't99-server-'))
        const devices = new PhoneDevices(path.join(dir, 'devices.json'))
        const socket = await fakeSocket(reply)
        const dock = dockFor(socket.file)
        const server = new PhoneServer({
            devices,
            push: { forgetOwner: () => undefined, publicKey: () => 'key', keysProblem: () => null, count: () => 0, onStatus: () => undefined } as never,
            tailscale: { read: async () => ({ found: false, owner: null, dnsName: null }), peek: () => null } as never,
            staticDir: dir,
            onStateChange: () => undefined,
            statusPoller: { start: () => undefined, stop: () => undefined },
            listSessions: () => ({ sessions: [], sessionFolders: [] }),
            sessionExists: () => false,
            conversation: {} as never,
            saveAttachment: () => ({ status: 'attached', path: '/tmp/x' }) as never,
            maskLine: (text: string) => text,
            recordPhoneInput: () => undefined,
            terminals: { attachRemote: async () => ({ snapshot: '', cols: 80, rows: 24, detach: () => undefined }), writeInput: () => true, events: new EventEmitter() as never },
            subscribeConversation: () => () => undefined,
            ...(withDock ? { dock } : {})
        })
        const state = await server.apply({ enabled: true, port: 0 } as never)
        expect(state.running).toBe(true)
        const pair = (role: 'drive' | 'watch'): string => {
            const { code } = devices.startPairing(role)
            const paired = devices.pair(code, `Phone ${role}`)
            if ('error' in paired) throw new Error(paired.error)
            return `climanager_phone=${paired.token}`
        }
        return {
            base: `http://127.0.0.1:${state.port}`,
            server,
            socket,
            pair,
            stop: async () => {
                await server.stop()
                await socket.close()
            }
        }
    }

    test('nobody without access reaches the socket: 401, Funnel 403, wrong Host 421, off', async () => {
        const h = await start(listReply([row('a')]))
        try {
            expect((await fetch(`${h.base}${PHONE_API.dock}`)).status).toBe(401)
            const cookie = h.pair('drive')
            const funnel = await fetch(`${h.base}${PHONE_API.dock}`, { headers: { cookie, 'Tailscale-Funnel-Request': '1' } })
            expect(funnel.status).toBe(403)
            expect(((await funnel.json()) as { error: string }).error).toBe('funnel')
            const status = await new Promise<number | undefined>((resolve) => {
                // fetch will not let a test set Host: a raw request does
                const client = net.createConnection(Number(new URL(h.base).port), '127.0.0.1', () => {
                    client.write(`GET ${PHONE_API.dock} HTTP/1.1\r\nHost: evil.example\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`)
                })
                client.on('data', (chunk) => {
                    resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(chunk.toString())?.[1]))
                    client.destroy()
                })
            })
            expect(status).toBe(421)
            expect(h.socket.connections(), 'none of those touched the socket').toBe(0)
        } finally {
            await h.stop()
        }
    })

    test('a paired device reads the list; a view-only device too; /me says there is a Dock', async () => {
        const h = await start(listReply([row('a')]))
        try {
            for (const role of ['drive', 'watch'] as const) {
                const cookie = h.pair(role)
                const me = (await (await fetch(`${h.base}${PHONE_API.me}`, { headers: { cookie } })).json()) as PhoneMe
                expect(me.access === 'full' && me.role).toBe(role)
                expect(me.access === 'full' && me.dock).toBe(true)
                const response = await fetch(`${h.base}${PHONE_API.dock}`, { headers: { cookie } })
                expect(response.status).toBe(200)
                expect(response.headers.get('cache-control')).toBe('no-store')
                expect(((await response.json()) as PhoneDockResponse).open.map((r) => r.title)).toEqual(['a'])
            }
            // a request with no access learns nothing about the Dock
            const none = (await (await fetch(`${h.base}${PHONE_API.me}`)).json()) as PhoneMe
            expect('dock' in none).toBe(false)
        } finally {
            await h.stop()
        }
    })

    test('no Dock on this Mac: 404 dock_not_installed and no line in /me', async () => {
        const h = await start(listReply(), false)
        try {
            const cookie = h.pair('drive')
            const me = (await (await fetch(`${h.base}${PHONE_API.me}`, { headers: { cookie } })).json()) as PhoneMe
            expect(me.access === 'full' && 'dock' in me).toBe(false)
            const response = await fetch(`${h.base}${PHONE_API.dock}`, { headers: { cookie } })
            expect(response.status).toBe(404)
            expect(((await response.json()) as { error: string }).error).toBe('dock_not_installed')
        } finally {
            await h.stop()
        }
    })

    test('only GET: nothing a phone sends reaches the socket', async () => {
        const h = await start(listReply([row('a')]))
        try {
            const cookie = h.pair('drive')
            const posted = await fetch(`${h.base}${PHONE_API.dock}`, {
                method: 'POST',
                headers: { cookie, 'Content-Type': 'application/json', origin: h.base },
                body: JSON.stringify({ cmd: 'open', url: 'file:///etc/passwd' })
            })
            expect(posted.status).toBe(404)
            await fetch(`${h.base}${PHONE_API.dock}?cmd=open&url=file:///etc/passwd`, { headers: { cookie } })
            expect(h.socket.received().every((sent) => sent === DOCK_REQUEST)).toBe(true)
        } finally {
            await h.stop()
        }
    })
})
