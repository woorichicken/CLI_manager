import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { decidePhoneAccess, hostAllowed, isTailnetAddress, parseTailscaleDnsName, parseTailscaleOwner, sameOrigin, type PhoneAccessInput } from '../../src/main/phone/phoneAccess'
import { PAIRING_CODE_ATTEMPTS, PAIRING_CODE_TTL_MS, PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhonePush } from '../../src/main/phone/PhonePush'
import { maskSnapshot } from '../../src/main/phone/phoneApi'
import { controlCharacter, createKeyRepeat, isRepeatable, KEY_BAR_ITEMS, KEY_REPEAT_DELAY_MS, KEY_REPEAT_INTERVAL_MS, keyBarLabel, keySequence, type KeyRepeatClock } from '../../src/renderer/src/phone/keyBar'
import { dropletFor, LONG_TURN_MS, nextSeen, waitingElsewhere } from '../../src/renderer/src/phone/droplets'
import { foldRows, type FoldLine } from '../../src/renderer/src/phone/terminalFold'
import { reconnectDelay } from '../../src/renderer/src/phone/usePhoneTerminal'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { listLines } from '../../src/renderer/src/phone/sessionListLines'
import { groupBySessionFolder, orderForAllSessions, sessionsInSidebarOrder } from '../../src/renderer/src/utils/sessionNavigation'
import type { ConversationSnapshot } from '../../src/shared/conversation'
import type { PhoneSession } from '../../src/shared/phone'
import type { TerminalSession, Workspace } from '../../src/shared/types'

/**
 * T75 — the phone connection's rules, without Electron.
 *
 * Access is a table: this Mac's owner (Tailscale login through serve, tailnet XFF), another
 * person, no header, a paired device (can type / view only), off, Funnel, not from this Mac.
 * Pairing: six digits, ten minutes, five wrong tries, only a hash on disk (0600), revoke.
 * Alerts: a question / a finished turn, once a minute per session, never while the Mac is in
 * use, never for a plain shell. Key bar sequences. Screen words in a card are masked.
 */

const OWNER = 'owner@example.com'
const SERVE_XFF = '100.101.102.103'

const base = (over: Partial<PhoneAccessInput> = {}): PhoneAccessInput => ({
    enabled: true,
    loopback: true,
    funnel: false,
    tailscaleLogin: null,
    forwardedFor: null,
    owner: OWNER,
    device: null,
    ...over
})

test.describe('T75 phone access table', () => {
    const rows: Array<[string, Partial<PhoneAccessInput>, ReturnType<typeof decidePhoneAccess>]> = [
        ['owner through serve', { tailscaleLogin: OWNER, forwardedFor: SERVE_XFF }, { level: 'full', role: 'drive', via: 'tailscale', login: OWNER }],
        ['owner, login in other case', { tailscaleLogin: 'Owner@Example.com', forwardedFor: SERVE_XFF }, { level: 'full', role: 'drive', via: 'tailscale', login: 'Owner@Example.com' }],
        ['owner over IPv6 tailnet', { tailscaleLogin: OWNER, forwardedFor: 'fd7a:115c:a1e0::1234' }, { level: 'full', role: 'drive', via: 'tailscale', login: OWNER }],
        ['another person', { tailscaleLogin: 'friend@example.com', forwardedFor: SERVE_XFF }, { level: 'none', reason: 'pairing_required' }],
        ['no login header', {}, { level: 'none', reason: 'pairing_required' }],
        ['owner login but no serve XFF', { tailscaleLogin: OWNER }, { level: 'none', reason: 'pairing_required' }],
        ['owner login from a LAN address', { tailscaleLogin: OWNER, forwardedFor: '192.168.0.10' }, { level: 'none', reason: 'pairing_required' }],
        ['owner login with a proxy chain', { tailscaleLogin: OWNER, forwardedFor: `${SERVE_XFF}, 10.0.0.1` }, { level: 'none', reason: 'pairing_required' }],
        ['Mac owner unknown (no Tailscale)', { tailscaleLogin: OWNER, forwardedFor: SERVE_XFF, owner: null }, { level: 'none', reason: 'pairing_required' }],
        ['paired device, can type', { device: { id: 'd1', label: 'iPhone', role: 'drive' } }, { level: 'full', role: 'drive', via: 'device', deviceId: 'd1', deviceLabel: 'iPhone' }],
        ['paired device, view only', { device: { id: 'd2', label: 'iPad', role: 'watch' } }, { level: 'full', role: 'watch', via: 'device', deviceId: 'd2', deviceLabel: 'iPad' }],
        ['switched off — even the owner', { enabled: false, tailscaleLogin: OWNER, forwardedFor: SERVE_XFF }, { level: 'none', reason: 'disabled' }],
        ['switched off — even a paired device', { enabled: false, device: { id: 'd1', label: 'iPhone', role: 'drive' } }, { level: 'none', reason: 'disabled' }],
        ['Funnel — even the owner', { funnel: true, tailscaleLogin: OWNER, forwardedFor: SERVE_XFF }, { level: 'none', reason: 'funnel' }],
        ['Funnel — even a paired device', { funnel: true, device: { id: 'd1', label: 'iPhone', role: 'drive' } }, { level: 'none', reason: 'funnel' }],
        ['not from this Mac', { loopback: false, tailscaleLogin: OWNER, forwardedFor: SERVE_XFF }, { level: 'none', reason: 'not_local' }]
    ]
    for (const [name, input, expected] of rows) {
        test(name, () => {
            expect(decidePhoneAccess(base(input))).toEqual(expected)
        })
    }

    test('tailnet addresses, Host and Origin', () => {
        expect(isTailnetAddress('100.64.0.1')).toBe(true)
        expect(isTailnetAddress('100.127.255.254')).toBe(true)
        expect(isTailnetAddress('100.128.0.1')).toBe(false)
        expect(isTailnetAddress('192.168.0.1')).toBe(false)
        expect(isTailnetAddress('fd7a:115c:a1e0:ab12::1')).toBe(true)
        expect(isTailnetAddress('')).toBe(false)
        for (const host of ['127.0.0.1:47830', 'localhost:47830', 'mac.tail1234.ts.net', 'MAC.tail1234.ts.net.', '100.101.102.103']) expect(hostAllowed(host), host).toBe(true)
        for (const host of ['evil.example', 'evil.example:47830', 'ts.net.evil.example', 'evil.example@localhost', '', undefined]) expect(hostAllowed(host), String(host)).toBe(false)
        expect(sameOrigin(undefined, 'mac.tail1234.ts.net')).toBe(true)
        expect(sameOrigin('https://mac.tail1234.ts.net', 'mac.tail1234.ts.net')).toBe(true)
        expect(sameOrigin('http://127.0.0.1:47830', '127.0.0.1:47830')).toBe(true)
        expect(sameOrigin('https://evil.example', 'mac.tail1234.ts.net')).toBe(false)
        expect(sameOrigin('null', '127.0.0.1:47830')).toBe(false)
    })

    test('the owner from `tailscale status --json`', () => {
        const status = (self: Record<string, unknown>) => JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.', ...self }, User: { '42': { LoginName: OWNER } } })
        expect(parseTailscaleOwner(status({ UserID: 42 }))).toBe(OWNER)
        // a tagged node belongs to no person
        expect(parseTailscaleOwner(status({ UserID: 42, Tags: ['tag:server'] }))).toBeNull()
        expect(parseTailscaleOwner(status({}))).toBeNull()
        expect(parseTailscaleOwner('not json')).toBeNull()
        expect(parseTailscaleOwner(null)).toBeNull()
        expect(parseTailscaleDnsName(status({ UserID: 42 }))).toBe('mac.tail1234.ts.net')
    })
})

test.describe('T75 pairing', () => {
    const tempFile = (): string => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t75-')), 'phone', 'devices.json')

    test('six digits, the right code pairs, only a hash is stored (0600), revoke', () => {
        const file = tempFile()
        const devices = new PhoneDevices(file)
        const code = devices.startPairing('drive')
        expect(code.code).toMatch(/^\d{6}$/)
        expect(devices.activePairing()?.code).toBe(code.code)
        const paired = devices.pair(`${code.code.slice(0, 3)} ${code.code.slice(3)}`, '  My\u0007 iPhone  ')
        expect('token' in paired).toBe(true)
        if (!('token' in paired)) return
        expect(paired.device).toMatchObject({ label: 'My iPhone', role: 'drive' })
        // the code is spent
        expect(devices.activePairing()).toBeNull()
        expect(devices.pair(code.code, 'again')).toEqual({ error: 'no_code' })
        // the cookie's token finds the device; the file holds its hash, not the token
        expect(devices.match(paired.token)).toMatchObject({ id: paired.device.id, role: 'drive' })
        const saved = fs.readFileSync(file, 'utf8')
        expect(saved).not.toContain(paired.token)
        expect(fs.statSync(file).mode & 0o777).toBe(0o600)
        // a new instance (app restart) still knows it
        expect(new PhoneDevices(file).match(paired.token)?.id).toBe(paired.device.id)
        expect(devices.list()).toHaveLength(1)
        let revoked: string | null | undefined
        devices.onRevoke((id) => (revoked = id))
        expect(devices.revoke(paired.device.id)).toBe(true)
        expect(revoked).toBe(paired.device.id)
        expect(devices.match(paired.token)).toBeNull()
        expect(devices.match('not-a-token')).toBeNull()
    })

    test(`${PAIRING_CODE_ATTEMPTS} wrong tries spend the code; it lapses after ten minutes`, () => {
        let now = 1_000_000
        const devices = new PhoneDevices(tempFile(), () => now)
        const code = devices.startPairing('watch').code
        const wrong = code === '000000' ? '111111' : '000000'
        for (let i = 0; i < PAIRING_CODE_ATTEMPTS - 1; i++) expect(devices.pair(wrong, 'x')).toEqual({ error: 'wrong_code' })
        expect(devices.activePairing()).not.toBeNull()
        expect(devices.pair(wrong, 'x')).toEqual({ error: 'wrong_code' })
        // the right code no longer works: there is none
        expect(devices.activePairing()).toBeNull()
        expect(devices.pair(code, 'x')).toEqual({ error: 'no_code' })

        const second = devices.startPairing('watch').code
        now += PAIRING_CODE_TTL_MS + 1
        expect(devices.activePairing()).toBeNull()
        expect(devices.pair(second, 'x')).toEqual({ error: 'no_code' })

        const third = devices.startPairing('watch').code
        const paired = devices.pair(third, 'Tablet')
        expect('device' in paired && paired.device.role).toBe('watch')
        devices.revokeAll()
        expect(devices.list()).toHaveLength(0)
    })
})

test.describe('T75 alerts', () => {
    test('a question, a finished turn, once a minute, not while the Mac is in use, not for a shell', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t75-push-'))
        const log = path.join(dir, 'push.log')
        process.env.CLIMANGER_TEST_USERDATA = dir
        process.env.CLIMANAGER_PHONE_PUSH_LOG = log
        let now = 10_000_000
        let inUse = false
        const push = new PhonePush({
            keysFile: path.join(dir, 'vapid.json'),
            subscriptionsFile: path.join(dir, 'push.json'),
            macInUse: () => inUse,
            session: (id) => (id === 'shell' ? { name: 'Shell', agent: false } : { name: `Agent ${id}`, agent: true }),
            now: () => now
        })
        const sent = (): Array<{ payload: { title: string; body: string; url: string } }> =>
            fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []
        const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

        // nobody subscribed: nothing, and the test alert says so
        push.onStatus([{ sessionId: 'a', state: 'waiting', question: 'Do you want to proceed?' }])
        await settle()
        expect(sent()).toHaveLength(0)
        expect(await push.test()).toMatchObject({ status: 'none' })

        expect(push.subscribe({ endpoint: 'http://not-https.example/x', keys: { p256dh: 'p', auth: 'a' } }, 'tailscale:o')).toBe(false)
        expect(push.subscribe({ endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } }, 'tailscale:o')).toBe(true)
        expect(push.count()).toBe(1)
        expect(fs.statSync(path.join(dir, 'push.json')).mode & 0o777).toBe(0o600)
        // the VAPID key pair is made on first use, in a 0600 file
        expect(push.publicKey()).toMatch(/^[A-Za-z0-9_-]{80,}$/)
        expect(fs.statSync(path.join(dir, 'vapid.json')).mode & 0o777).toBe(0o600)

        push.onStatus([{ sessionId: 'a', state: 'idle' }])
        push.onStatus([{ sessionId: 'a', state: 'waiting', question: 'Do you want to proceed?' }])
        await settle()
        expect(sent()).toHaveLength(1)
        expect(sent()[0].payload).toMatchObject({ title: 'Agent a needs you', body: 'Do you want to proceed?', url: '/?session=a&view=chat' })

        // the same session again within a minute: held back
        now += 10_000
        push.onStatus([{ sessionId: 'a', state: 'working' }])
        now += 20_000
        push.onStatus([{ sessionId: 'a', state: 'idle' }])
        await settle()
        expect(sent()).toHaveLength(1)

        // a minute later, a turn that worked long enough ends: "finished"
        now += 60_000
        push.onStatus([{ sessionId: 'a', state: 'working' }])
        now += 6_000
        push.onStatus([{ sessionId: 'a', state: 'idle' }])
        await settle()
        expect(sent()).toHaveLength(2)
        expect(sent()[1].payload.title).toBe('Agent a finished')

        // a short turn is not worth a buzz
        now += 61_000
        push.onStatus([{ sessionId: 'b', state: 'working' }])
        now += 1_000
        push.onStatus([{ sessionId: 'b', state: 'idle' }])
        // a plain shell never alerts
        push.onStatus([{ sessionId: 'shell', state: 'waiting', question: 'Continue?' }])
        // someone is at the Mac using the app
        inUse = true
        push.onStatus([{ sessionId: 'c', state: 'waiting', question: 'Proceed?' }])
        await settle()
        expect(sent()).toHaveLength(2)

        // the test alert goes whatever the Mac does
        expect(await push.test()).toEqual({ status: 'sent', devices: 1 })
        expect(sent()[2].payload.title).toBe('CLI Manager')

        // a revoked device's subscriptions go with it; the owner's stay
        push.subscribe({ endpoint: 'https://push.example/dev', keys: { p256dh: 'p', auth: 'a' } }, 'device:d1')
        expect(push.count()).toBe(2)
        push.forgetOwner('device:d1')
        expect(push.count()).toBe(1)
        delete process.env.CLIMANAGER_PHONE_PUSH_LOG
        delete process.env.CLIMANGER_TEST_USERDATA
    })
})

test.describe('T75 key bar and masking', () => {
    test('key bar: ovis order, sequences, Ctrl + letter', () => {
        expect(KEY_BAR_ITEMS.map(keyBarLabel)).toEqual(['Esc', 'Tab', 'Ctrl', '↑', '↓', '←', '→', '^C', '⏎'])
        expect(keySequence('Escape', false, false)).toBe('\x1b')
        expect(keySequence('Tab', false, false)).toBe('\t')
        expect(keySequence('ctrl-c', false, false)).toBe('\x03')
        expect(keySequence('Enter', false, false)).toBe('\r')
        expect(keySequence('ArrowUp', false, false)).toBe('\x1b[A')
        expect(keySequence('ArrowUp', true, false)).toBe('\x1bOA')
        expect(keySequence('ArrowLeft', true, true)).toBe('\x1b[1;5D')
        expect(controlCharacter('r')).toBe('\x12')
        expect(controlCharacter('D')).toBe('\x04')
        expect(controlCharacter('ab')).toBeNull()
        expect(controlCharacter('1')).toBeNull()
    })

    test('a question card read off the screen is masked; its signature is kept', () => {
        const key = ['sk', 'ant', 'api03', 'abcdefghijklmnopqrstuvwxyz012345'].join('-')
        const snapshot = {
            sessionId: 's',
            agent: 'claude',
            turns: [],
            totalTurns: 0,
            truncated: false,
            working: false,
            queued: [],
            meta: null,
            revision: 1,
            prompt: {
                agent: 'claude',
                kind: 'permission',
                question: 'Do you want to proceed?',
                context: [`curl -H "Authorization: Bearer ${key}" https://api.example`],
                options: [{ index: 0, number: 1, label: `Yes, and allow ${key}`, selected: true }],
                multi: false,
                answerable: true,
                signature: 'sig-1'
            }
        } as ConversationSnapshot
        const mask = (text: string) => text.split(key).join('[REDACTED]')
        const masked = maskSnapshot(snapshot, mask)
        expect(JSON.stringify(masked)).not.toContain(key)
        expect(masked.prompt?.signature).toBe('sig-1')
        expect(masked.prompt?.question).toBe('Do you want to proceed?')
        // nothing to mask without a card
        const plain = { ...snapshot, prompt: null }
        expect(maskSnapshot(plain, mask)).toBe(plain)
    })
})

test.describe('T75 session list order', () => {
    const session = (id: string, extra: Partial<TerminalSession> = {}): TerminalSession => ({ id, name: id, cwd: '/tmp', type: 'regular', ...extra })
    const workspace = (id: string, sessions: TerminalSession[], extra: Partial<Workspace> = {}): Workspace =>
        ({ id, name: `ws ${id}`, path: '/tmp', sessions, createdAt: 0, ...extra } as Workspace)

    test("the Mac's All sessions List: session folders first, pinned then recently viewed; the phone draws it unchanged", () => {
        const workspaces = [
            workspace('home', [session('h1')], { isHome: true }),
            workspace('a', [session('a1', { sessionFolderId: 'sf' }), session('a2', { isPinned: true }), session('a3')]),
            // a folder that no longer exists counts as none, as on the Mac
            workspace('b', [session('b1', { sessionFolderId: 'sf', isPinned: true }), session('b2', { sessionFolderId: 'gone' })])
        ]
        const entries = orderForAllSessions(sessionsInSidebarOrder(workspaces, [], true, true), ['a3', 'a1'])
        const grouped = groupBySessionFolder(entries, [{ id: 'sf', name: 'Agents' }])
        const ordered = [...grouped.folders.flatMap((group) => group.rows), ...grouped.unfiled]
        // folder: pinned b1, then a1 (looked at); the rest: pinned a2, then a3 (looked at), then sidebar order
        expect(ordered.map((entry) => entry.session.id)).toEqual(['b1', 'a1', 'a2', 'a3', 'h1', 'b2'])

        const phoneSession = ({ workspace: w, session: s }: (typeof ordered)[number]): PhoneSession => ({
            id: s.id,
            name: s.name,
            workspaceId: w.id,
            workspaceName: w.name,
            agent: null,
            state: 'idle',
            ...(s.sessionFolderId === 'sf' ? { sessionFolderId: 'sf' } : {}),
            ...(s.isPinned ? { pinned: true } : {})
        })
        const drawn = (sessionFolders: Array<{ id: string; name: string }>) =>
            listLines({ sessions: ordered.map(phoneSession), sessionFolders }).map((line) =>
                line.kind === 'row' ? line.session.id : line.kind === 'folder' ? `# ${line.title}` : '---')
        expect(drawn([{ id: 'sf', name: 'Agents' }])).toEqual(['# Agents', 'b1', '---', 'a1', '# No folder', 'a2', '---', 'a3', 'h1', 'b2'])
        // no session folders on the Mac: no headings, only the pinned line
        expect(drawn([]).filter((line) => line.startsWith('#'))).toEqual([])
    })
})


// ---- quality pass (quality-phone, 11-04): ovis droplet · key hold-repeat · reconnect · «Wrap to screen» ----

const session = (id: string, state: PhoneSession['state'], over: Partial<PhoneSession> = {}): PhoneSession => ({
    id,
    name: id.toUpperCase(),
    workspaceId: 'w',
    workspaceName: 'W',
    agent: 'claude',
    state,
    ...over
})

test.describe('T75 in-app alert (droplet)', () => {
    test('a question elsewhere is news; the open session, the first load and a new session are not', () => {
        const t0 = 1_000_000
        const first = [session('a', 'idle'), session('b', 'working'), session('c', 'idle')]
        // first load: nothing is new
        expect(dropletFor(null, first, 'a', t0)).toBeNull()
        const seen = nextSeen(null, first, t0)
        // c starts waiting while a is open → told, with the question
        const asked = [session('a', 'idle'), session('b', 'working'), session('c', 'waiting', { question: 'Do you want to proceed?' })]
        expect(dropletFor(seen, asked, 'a', t0 + 3000)).toEqual({ sessionId: 'c', name: 'C', kind: 'waiting', detail: 'Do you want to proceed?' })
        // the open one asking is in front of the user already
        expect(dropletFor(seen, asked, 'c', t0 + 3000)).toBeNull()
        // still waiting on the next poll: not news twice
        const seen2 = nextSeen(seen, asked, t0 + 3000)
        expect(dropletFor(seen2, asked, 'a', t0 + 6000)).toBeNull()
        // a session the list did not have before is not news
        expect(dropletFor(seen2, [...asked, session('d', 'waiting')], 'a', t0 + 6000)).toBeNull()
        // the ☰ badge counts the waiting ones that are not open
        expect(waitingElsewhere(asked, 'a')).toBe(1)
        expect(waitingElsewhere(asked, 'c')).toBe(0)
    })

    test('a finished turn is told only when it worked a minute (ovis done: "long"), never a shell or an exit', () => {
        const t0 = 5_000_000
        const working = [session('a', 'idle'), session('b', 'working'), session('s', 'working', { agent: null })]
        // b seen working at first sight: when it began is unknown — told, as ovis tells a turn it did not see start
        const seenAtFirst = nextSeen(null, working, t0)
        expect(dropletFor(seenAtFirst, [session('a', 'idle'), session('b', 'idle'), session('s', 'idle', { agent: null })], 'a', t0 + 3000)).toEqual({ sessionId: 'b', name: 'B', kind: 'finished' })
        // b seen to start working at t0+3000: a short turn is not told, a minute's is
        const idle = [session('a', 'idle'), session('b', 'idle')]
        const seen = nextSeen(nextSeen(null, idle, t0), [session('a', 'idle'), session('b', 'working')], t0 + 3000)
        expect(dropletFor(seen, idle, 'a', t0 + 3000 + 20_000)).toBeNull()
        expect(dropletFor(seen, idle, 'a', t0 + 3000 + LONG_TURN_MS)?.kind).toBe('finished')
        // an exit is not a finished turn
        expect(dropletFor(seen, [session('a', 'idle'), session('b', 'exited')], 'a', t0 + 3000 + LONG_TURN_MS)).toBeNull()
        // a question wins over a finish in the same poll
        const both = nextSeen(null, [session('a', 'idle'), session('b', 'working'), session('c', 'idle')], t0)
        expect(dropletFor(both, [session('a', 'idle'), session('b', 'idle'), session('c', 'waiting')], 'a', t0 + LONG_TURN_MS)?.sessionId).toBe('c')
    })
})

test.describe('T75 key bar hold-repeat', () => {
    /** a clock the test turns by hand */
    const manualClock = (): KeyRepeatClock & { tick(ms: number): void } => {
        let now = 0
        let timers: Array<{ at: number; run: () => void; id: number }> = []
        let next = 1
        return {
            setTimeout: (run, delay) => {
                const id = next++
                timers.push({ at: now + delay, run, id })
                return id
            },
            clearTimeout: (id) => {
                timers = timers.filter((t) => t.id !== id)
            },
            tick(ms) {
                const end = now + ms
                for (;;) {
                    const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0]
                    if (!due) break
                    timers = timers.filter((t) => t !== due)
                    now = due.at
                    due.run()
                }
                now = end
            }
        }
    }

    test('only the arrows repeat; a hold sends after 400 ms then every 50 ms, and its click is not one more', () => {
        expect(KEY_BAR_ITEMS.filter(isRepeatable).map(keyBarLabel)).toEqual(['↑', '↓', '←', '→'])
        const clock = manualClock()
        let sent = 0
        const repeat = createKeyRepeat(() => sent++, clock)
        // a tap: nothing from the timer, the click sends it
        repeat.press(10, 10)
        clock.tick(100)
        repeat.release()
        expect(sent).toBe(0)
        expect(repeat.takeClick()).toBe(true)
        // a hold of 400 + 3×50 ms: four sends, and the click after it is swallowed
        repeat.press(10, 10)
        clock.tick(KEY_REPEAT_DELAY_MS + 3 * KEY_REPEAT_INTERVAL_MS)
        repeat.release()
        expect(sent).toBe(4)
        expect(repeat.takeClick()).toBe(false)
        expect(repeat.takeClick()).toBe(true)
        // a finger that slides past 10 px before repeating was scrolling the bar
        repeat.press(10, 10)
        expect(repeat.move(30, 10)).toBe(true)
        clock.tick(1000)
        expect(sent).toBe(4)
    })
})

test.describe('T75 reconnect', () => {
    test('the wait doubles from 250 ms and stops at 5 s', () => {
        expect([0, 1, 2, 3, 4, 5, 9].map(reconnectDelay)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000])
    })
})

test.describe('T75 «Wrap to screen» rows', () => {
    const THEME = { foreground: '#e0e0e0', background: '#0f0f12', cursor: '#ffffff' }
    const write = (term: HeadlessTerminal, data: string): Promise<void> => new Promise((resolve) => term.write(data, resolve))
    const textOf = (html: string): string => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

    test('rows the Mac wrapped join, trailing blanks go, colours stay, rules and frame edges, cursor', async () => {
        const term = new HeadlessTerminal({ cols: 40, rows: 10, allowProposedApi: true })
        const long = 'x'.repeat(50) // wraps at the Mac's 40 columns into two rows
        await write(term, `\x1b[32mgreen\x1b[0m plain\r\n${long}\r\n${'─'.repeat(40)}\r\n│ 안녕 세계${' '.repeat(20)}│\r\n> `)
        const buffer = term.buffer.active
        const lines = foldRows((row) => buffer.getLine(row) as FoldLine | undefined, buffer.viewportY, term.rows, term.cols, THEME, { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX })
        // 5 lines drawn (the 50-x line joined back), the 5 blank rows under the cursor dropped
        expect(lines.map((line) => textOf(line.html))).toEqual(['green plain', long, '─'.repeat(40), '│ 안녕 세계', '>  '])  // the cursor's blank cell is drawn (its block)
        // the green run keeps its colour (palette 2)
        expect(lines[0].html).toContain('color:#4e9a06')
        // a rule is one cut line; a frame's right edge after padding is dropped, the left edge and 한글 stay
        expect(lines.map((line) => line.rule)).toEqual([false, false, true, false, false])
        // the cursor's line draws a block
        expect(lines[4].cursor).toBe(true)
        expect(lines[4].html).toContain('phone-fold-cursor')
        // no cursor (hidden): no block
        const hidden = foldRows((row) => buffer.getLine(row) as FoldLine | undefined, buffer.viewportY, term.rows, term.cols, THEME, null)
        expect(hidden.some((line) => line.html.includes('phone-fold-cursor'))).toBe(false)
        // markup in the screen is text, not HTML
        await write(term, '\r\n<b>&</b>')
        const escaped = foldRows((row) => buffer.getLine(row) as FoldLine | undefined, buffer.viewportY, term.rows, term.cols, THEME, null)
        expect(escaped[escaped.length - 1].html).toBe('&lt;b&gt;&amp;&lt;/b&gt;')
        term.dispose()
    })
})
