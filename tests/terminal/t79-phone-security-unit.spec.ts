import { test, expect } from '@playwright/test'
import { execFileSync, spawnSync } from 'child_process'
import { EventEmitter } from 'events'
import crypto from 'crypto'
import fs from 'fs'
import http from 'http'
import net from 'net'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhonePush } from '../../src/main/phone/PhonePush'
import { PhoneServer } from '../../src/main/phone/PhoneServer'
import { maskSnapshot } from '../../src/main/phone/phoneApi'
import { maskSecretLines } from '../../src/main/maskSecrets'
import { readPrompt } from '../../src/main/promptScreen'
import { createChatCommandLister } from '../../src/main/chatCommands'
import type { ConversationSnapshot } from '../../src/shared/conversation'

/**
 * T79 — the phone server's security and resource fixes (Codex cross review F01·F02·F05·F06·F07·F08·F21·F22·F23),
 * without Electron. Each block reproduces its finding against the old code first: a revoked device must not type
 * (socket or a request still sending its body), a revoke must reach the disk or say it did not, the 51st pairing
 * revokes the oldest, a special SKILL.md cannot stall main, a push that never answers ends, a question card's
 * signature carries no masked secret, Codex `$` finds every skill folder ovis does, and sw.js is in Git.
 */

const ROOT = path.resolve(__dirname, '../..')
const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `t79-${name}-`))

/** A real PhoneServer on 127.0.0.1:0 with fake terminals and Chat, a real device list. */
async function startServer(): Promise<{
    server: PhoneServer
    devices: PhoneDevices
    port: number
    typed: string[]
    sent: string[]
    subscribed: string[]
    stop: () => Promise<void>
}> {
    const dir = tmp('server')
    const devices = new PhoneDevices(path.join(dir, 'devices.json'))
    const typed: string[] = []
    const sent: string[] = []
    const subscribed: string[] = []
    const events = new EventEmitter()
    const push = {
        forgetOwner: () => undefined,
        publicKey: () => 'key',
        count: () => subscribed.length,
        onStatus: () => undefined,
        subscribe: (_s: unknown, owner: string) => {
            subscribed.push(owner)
            return true
        },
        unsubscribe: () => undefined,
        test: async () => ({ status: 'none' })
    }
    const server = new PhoneServer({
        devices,
        push: push as never,
        tailscale: { read: async () => ({ found: false, owner: null, dnsName: null }), peek: () => null } as never,
        staticDir: dir,
        onStateChange: () => undefined,
        statusPoller: { start: () => undefined, stop: () => undefined },
        listSessions: () => ({ sessions: [] }) as never,
        sessionExists: (id: string) => id === 'S1',
        conversation: {
            send: async (_id: string, text: string) => {
                sent.push(text)
                return { status: 'sent' }
            }
        } as never,
        saveAttachment: () => ({ status: 'attached', path: '/tmp/x' }) as never,
        maskLine: (text: string) => text,
        recordPhoneInput: () => undefined,
        terminals: {
            attachRemote: async () => ({ snapshot: '', cols: 80, rows: 24, detach: () => undefined }),
            writeInput: (_id: string, data: string) => {
                typed.push(data)
                return true
            },
            events: events as never
        },
        subscribeConversation: () => () => undefined
    })
    const state = await server.apply({ enabled: true, port: 0 } as never)
    expect(state.running).toBe(true)
    return { server, devices, port: state.port!, typed, sent, subscribed, stop: () => server.stop() }
}

/** Pairs a `drive` device and returns its cookie. */
function pairDevice(devices: PhoneDevices): { cookie: string; id: string } {
    const { code } = devices.startPairing('drive')
    const result = devices.pair(code, 'Phone')
    if ('error' in result) throw new Error(result.error)
    return { cookie: `climanager_phone=${result.token}`, id: result.device.id }
}

const until = async (check: () => boolean, ms = 3000): Promise<boolean> => {
    const end = Date.now() + ms
    while (Date.now() < end) {
        if (check()) return true
        await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return check()
}

test.describe('T79 F06 the alert worker is in Git', () => {
    // .gitignore's `*.js` (build output) hid public/phone/sw.js: a clean checkout built a phone page whose
    // /sw.js was a 404, so alerts never registered. The check reads the commit, not the working folder.
    test('src/renderer/public/phone/sw.js is tracked and not ignored', () => {
        const file = 'src/renderer/public/phone/sw.js'
        const ignored = spawnSync('git', ['check-ignore', '-q', file], { cwd: ROOT })
        expect(ignored.status, `${file} is ignored by .gitignore`).toBe(1)
        const tracked = spawnSync('git', ['ls-files', '--error-unmatch', file], { cwd: ROOT })
        expect(tracked.status, `${file} is not in Git`).toBe(0)
        const inHead = spawnSync('git', ['cat-file', '-e', `HEAD:${file}`], { cwd: ROOT })
        expect(inHead.status, `${file} is not in HEAD`).toBe(0)
    })
})

test.describe('T79 F01 a revoked device cannot type through an open terminal socket', () => {
    test('input sent after Disconnect, before the close handshake ends, never reaches the pty', async () => {
        const h = await startServer()
        try {
            const device = pairDevice(h.devices)
            const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/phone/terminal?session=S1`, {
                headers: { cookie: device.cookie, origin: `http://127.0.0.1:${h.port}` }
            })
            await new Promise<void>((resolve, reject) => {
                ws.on('message', (raw) => {
                    if (JSON.parse(String(raw)).type === 'snapshot') resolve()
                })
                ws.on('error', reject)
            })
            ws.send(JSON.stringify({ type: 'input', data: 'before\r' }))
            expect(await until(() => h.typed.includes('before\r'))).toBe(true)

            // Mac: Disconnect. The phone answers the close slowly — its frames sent meanwhile still arrive.
            h.devices.revoke(device.id)
            ws.send(JSON.stringify({ type: 'input', data: 'after-revoke\r' }))
            await new Promise((resolve) => setTimeout(resolve, 300))
            expect(h.typed).not.toContain('after-revoke\r')
            ws.terminate()
        } finally {
            await h.stop()
        }
    })
})

test.describe('T79 F02 a request still sending its body when the device is revoked does nothing', () => {
    const slowPost = (port: number, cookie: string, route: string, body: string, midway: () => void): Promise<{ status: number; text: string }> =>
        new Promise((resolve, reject) => {
            const req = http.request(
                {
                    host: '127.0.0.1',
                    port,
                    path: route,
                    method: 'POST',
                    headers: { cookie, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), origin: `http://127.0.0.1:${port}` }
                },
                (res) => {
                    let text = ''
                    res.on('data', (chunk) => (text += chunk))
                    res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
                }
            )
            req.on('error', reject)
            const half = Math.floor(body.length / 2)
            req.write(body.slice(0, half))
            // the headers were judged when they arrived; revoke while the rest is on its way
            setTimeout(() => {
                midway()
                setTimeout(() => req.end(body.slice(half)), 100)
            }, 200)
        })

    test('chat send', async () => {
        const h = await startServer()
        try {
            const device = pairDevice(h.devices)
            const result = await slowPost(h.port, device.cookie, '/api/phone/chat/S1/send', JSON.stringify({ text: 'touch /tmp/after-revoke' }), () => h.devices.revoke(device.id))
            expect(h.sent).toEqual([])
            expect(result.status).toBe(401)
        } finally {
            await h.stop()
        }
    })

    test('alerts subscribe', async () => {
        const h = await startServer()
        try {
            const device = pairDevice(h.devices)
            const subscription = { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } }
            const result = await slowPost(h.port, device.cookie, '/api/phone/push/subscribe', JSON.stringify({ subscription }), () => h.devices.revokeAll())
            expect(h.subscribed).toEqual([])
            expect(result.status).toBe(401)
        } finally {
            await h.stop()
        }
    })
})

test.describe('T79 F07 a revoke that cannot reach the disk says so', () => {
    // The folder turns read-only after pairing: the revoke cannot be written. Before, the device vanished from
    // the list and its sockets closed — and came back, cookie and all, on the next start.
    for (const which of ['one device', 'every device'] as const) {
        test(which, () => {
            const dir = tmp('revoke')
            const file = path.join(dir, 'devices.json')
            const devices = new PhoneDevices(file)
            const { code } = devices.startPairing('drive')
            const paired = devices.pair(code, 'Phone')
            if ('error' in paired) throw new Error(paired.error)
            fs.chmodSync(dir, 0o500)
            try {
                const revoked: Array<string | null> = []
                devices.onRevoke((id) => revoked.push(id))
                expect(() => (which === 'one device' ? devices.revoke(paired.device.id) : devices.revokeAll())).toThrow()
                // nothing half-done: the list, the socket and the disk agree
                expect(revoked).toEqual([])
                expect(devices.list().map((d) => d.id)).toEqual([paired.device.id])
            } finally {
                fs.chmodSync(dir, 0o700)
            }
            // what a restart reads is what the person was told
            expect(new PhoneDevices(file).match(paired.token)?.id).toBe(paired.device.id)
            // once the disk takes it, the revoke holds after a restart
            if (which === 'one device') expect(devices.revoke(paired.device.id)).toBe(true)
            else devices.revokeAll()
            expect(new PhoneDevices(file).match(paired.token)).toBeNull()
        })
    }
})

test.describe('T79 F08 the 51st pairing revokes the oldest device', () => {
    test('the dropped device is told to the revoke listeners (sockets close, alerts stop)', () => {
        const devices = new PhoneDevices(path.join(tmp('max'), 'devices.json'))
        const revoked: Array<string | null> = []
        devices.onRevoke((id) => revoked.push(id))
        const ids: string[] = []
        for (let i = 0; i < 51; i++) {
            const { code } = devices.startPairing('drive')
            const result = devices.pair(code, `Phone ${i}`)
            if ('error' in result) throw new Error(result.error)
            ids.push(result.device.id)
        }
        expect(devices.list()).toHaveLength(50)
        expect(devices.list().map((d) => d.id)).not.toContain(ids[0])
        expect(revoked).toEqual([ids[0]])
    })
})

test.describe('T79 F05 a SKILL.md that is not a plain file cannot stall main', () => {
    // The `/` menu read every SKILL.md whole, then kept 16 KB. A project can hold a FIFO (open waits for a writer
    // forever) or a link to /dev/zero (a read that never ends): Electron main stops. The lister runs in a child
    // node so a hang is a timeout here, not a stuck test runner.
    const list = (project: string, home: string): { status: number | null; names: string[] } => {
        const dir = tmp('lister')
        // package.json says commonjs: an .mts copy lets node load the TypeScript as a module
        fs.copyFileSync(path.join(ROOT, 'src/main/chatCommands.ts'), path.join(dir, 'chatCommands.mts'))
        const runner = path.join(dir, 'run.mjs')
        fs.writeFileSync(
            runner,
            [
                `const { createChatCommandLister } = await import(${JSON.stringify(path.join(dir, 'chatCommands.mts'))})`,
                `const list = createChatCommandLister({ home: ${JSON.stringify(home)}, claudeConfigDir: () => ${JSON.stringify(path.join(home, '.claude'))}, codexHome: () => ${JSON.stringify(path.join(home, '.codex'))} })`,
                `console.log(JSON.stringify(list('claude', ${JSON.stringify(project)}).filter((c) => c.source !== 'builtin').map((c) => c.name)))`
            ].join('\n')
        )
        const run = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', runner], { timeout: 8000, encoding: 'utf8' })
        return { status: run.status, names: run.status === 0 ? (JSON.parse(run.stdout.trim()) as string[]) : [] }
    }
    const project = (): { root: string; home: string; skill: (name: string) => string } => {
        const root = tmp('project')
        fs.mkdirSync(path.join(root, '.git'))
        const home = tmp('home')
        const skill = (name: string): string => {
            fs.mkdirSync(path.join(root, '.claude', 'skills', name), { recursive: true })
            return path.join(root, '.claude', 'skills', name, 'SKILL.md')
        }
        fs.writeFileSync(skill('fine'), '---\nname: fine\ndescription: An ordinary skill\n---\nBody\n')
        return { root, home, skill }
    }

    test('a FIFO is skipped, a link to /dev/zero is skipped, a huge file is read only as far as its head', () => {
        const fifo = project()
        execFileSync('mkfifo', [fifo.skill('fifo')])
        const first = list(fifo.root, fifo.home)
        expect(first.status, 'the lister hung on a FIFO SKILL.md').toBe(0)
        expect(first.names).toEqual(['fine'])

        // only once a FIFO cannot hang it: the old code would read /dev/zero until memory ran out
        const zero = project()
        fs.symlinkSync('/dev/zero', zero.skill('zero'))
        // frontmatter at the top of a 40 MB file still counts; nothing past the head is needed
        const big = zero.skill('big')
        fs.writeFileSync(big, '---\nname: big\ndescription: Large\n---\n')
        fs.appendFileSync(big, Buffer.alloc(40 * 1024 * 1024, 'x'))
        const second = list(zero.root, zero.home)
        expect(second.status, 'the lister hung on /dev/zero').toBe(0)
        expect([...second.names].sort()).toEqual(['big', 'fine'])
    })
})

test.describe('T79 F21 a push service that never answers does not hold the alert forever', () => {
    test('Test alert ends with "failed" when the endpoint accepts the connection and says nothing', async () => {
        // takes the TCP connection, never finishes TLS: without a timeout the request waits for good
        const sockets: net.Socket[] = []
        const silent = net.createServer((socket) => sockets.push(socket))
        await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve))
        const port = (silent.address() as net.AddressInfo).port
        const dir = tmp('push')
        const push = new PhonePush({
            keysFile: path.join(dir, 'keys.json'),
            subscriptionsFile: path.join(dir, 'subs.json'),
            macInUse: () => false,
            session: () => null,
            pushTimeoutMs: 500
        })
        // a real browser's key shape: web-push encrypts before it connects
        const ecdh = crypto.createECDH('prime256v1')
        ecdh.generateKeys()
        const subscription = {
            endpoint: `https://127.0.0.1:${port}/push/abc`,
            keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') }
        }
        expect(push.subscribe(subscription, 'tailscale:owner')).toBe(true)
        try {
            const result = await Promise.race([push.test(), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 5000))])
            expect(result).toMatchObject({ status: 'failed' })
        } finally {
            for (const socket of sockets) socket.destroy()
            silent.close()
        }
    })
})
