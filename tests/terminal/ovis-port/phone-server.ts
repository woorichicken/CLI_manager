/**
 * Group `phone-server` — ovis tests moved onto our phone server modules (no Electron).
 *
 *   ovis server/access.test.ts   (3e51902) → src/main/phone/phoneAccess.ts
 *   ovis server/devices.test.ts  (3e51902) → src/main/phone/PhoneDevices.ts (+ parseTailscaleOwner in phoneAccess.ts)
 *   ovis server/push.test.ts     (3e51902) → src/main/phone/PhonePush.ts
 *
 * Inputs and expected values are ovis's. Only the call is adapted to our API
 * (decidePhoneAccess input shape, injected clock, test-mode push log). Cases that call
 * something we did not port (token, Portal, relay, open mode, bind scope, ...) are not moved.
 * Where our design differs on purpose, the test is `test.fixme` with the reason (docs/decisions/0009).
 */
import { test, expect } from '@playwright/test'
import { createECDH, randomBytes } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import webpush from 'web-push'
import {
    decidePhoneAccess,
    hostAllowed,
    isLoopbackAddress,
    parseTailscaleOwner,
    type PhoneAccessInput
} from '../../../src/main/phone/phoneAccess'
import { cleanLabel, PhoneDevices } from '../../../src/main/phone/PhoneDevices'
import { PhonePush, type PhonePushDeps } from '../../../src/main/phone/PhonePush'

// ---------------------------------------------------------------- access

const device = { id: 'd1', label: 'Phone', role: 'drive' as const }
const baseAccess: PhoneAccessInput = {
    enabled: true,
    loopback: true,
    funnel: false,
    tailscaleLogin: null,
    forwardedFor: '100.64.0.9',
    owner: null,
    device: null
}
/** ovis `via()`: the way in, or `refused:<reason>` */
const via = (input: Partial<PhoneAccessInput>): string => {
    const a = decidePhoneAccess({ ...baseAccess, ...input })
    return a.level === 'full' ? a.via : `refused:${a.reason}`
}
const NODE = 'pc.tail5cc90b.ts.net'
const IP = '100.64.0.7'

test.describe('ovis server/access.test.ts', () => {
    test.describe('decideAccess', () => {
        for (const forwardedFor of [null, '127.0.0.1', '203.0.113.50', '100.101.102.103, 100.64.0.9', '100.63.255.255', '100.128.0.0', 'fd7a:115c:a1e1::1', '100.64.0.999', '::ffff:100.64.0.9']) {
            test(`regression: refuses a login forwarded for ${forwardedFor}`, () => {
                const input = { ...baseAccess, tailscaleLogin: 'me@example.com', owner: 'me@example.com', forwardedFor }
                expect(decidePhoneAccess(input)).toEqual({ level: 'none', reason: 'pairing_required' })
            })
        }

        for (const forwardedFor of ['100.101.102.103', '100.64.0.0', '100.127.255.255', 'fd7a:115c:a1e0::1', 'FD7A:115C:A1E0:0:0:0:0:1']) {
            test(`control: accepts a login forwarded for ${forwardedFor}`, () => {
                const input = { ...baseAccess, tailscaleLogin: 'me@example.com', owner: 'me@example.com', forwardedFor }
                expect(decidePhoneAccess(input)).toMatchObject({ level: 'full', via: 'tailscale' })
            })
        }

        test('regression: a rejected login never falls through to the serve-only owner grant', () => {
            // serve-only / sole-login grant is not ported: the rejected login must simply be refused
            const input = { ...baseAccess, tailscaleLogin: 'me@example.com', owner: 'me@example.com', forwardedFor: '127.0.0.1' }
            expect(decidePhoneAccess(input)).toEqual({ level: 'none', reason: 'pairing_required' })
        })

        test('lets this PC in without a token, but not through a proxy', () => {
            test.fixme(true, 'phoneAccess.ts:23 — no open mode / no local grant: a request with no login is never the owner, so a bare loopback request pairs')
            expect(via({})).toBe('local')
            expect(via({ forwardedFor: '100.64.0.9', device: null })).toBe('refused:pairing_required')
        })

        test('keeps everything open, as before, while no token and no device exist', () => {
            test.fixme(true, 'phoneAccess.ts:23 — no open mode; and phoneAccess.ts:71 a non-loopback peer is refused as not_local')
            expect(via({ loopback: false })).toBe('open')
            expect(via({ loopback: true })).toBe('open')
            expect(via({ loopback: false })).toBe('refused:pairing_required')
        })

        test('never treats a Funnel request as open', () => {
            test.fixme(true, 'phoneAccess.ts:69 + shared/phone.ts:21 — Funnel is refused with its own reason, paired cookie or not (0009 "Who gets in")')
            expect(via({ funnel: true })).toBe('refused:pairing_required')
            expect(via({ funnel: true, device })).toBe('device')
        })

        test("trusts the PC's own Tailscale login only from the local tailscaled", () => {
            test.fixme(true, 'shared/phone.ts:19 — a non-owner login is "pairing_required" (no other_user); no open mode (phoneAccess.ts:23); off-machine is not_local (phoneAccess.ts:71)')
            expect(via({ tailscaleLogin: 'me@example.com', owner: 'me@example.com' })).toBe('tailscale')
            expect(via({ tailscaleLogin: 'Me@Example.com', owner: 'me@example.com' })).toBe('tailscale')
            expect(via({ tailscaleLogin: 'them@example.com', owner: 'me@example.com' })).toBe('refused:other_user')
            expect(via({ loopback: false, tailscaleLogin: 'me@example.com', owner: 'me@example.com' })).toBe('refused:pairing_required')
            expect(via({ owner: 'me@example.com' })).toBe('refused:pairing_required')
            expect(via({ owner: 'me@example.com', device })).toBe('device')
            expect(via({ tailscaleLogin: 'me@example.com', owner: null })).toBe('open')
        })

        test('a paired device gets in from anywhere, with its role', () => {
            test.fixme(true, 'phoneAccess.ts:71 + 0009 — the server listens on 127.0.0.1 only; a non-loopback peer is refused even with a device')
            const access = decidePhoneAccess({ ...baseAccess, loopback: false, device: { ...device, role: 'watch' } })
            expect(access).toEqual({ level: 'full', via: 'device', role: 'watch', deviceId: 'd1', deviceLabel: 'Phone' })
        })

        test('knows a name for this machine from a proxied Host', () => {
            // ovis isLoopbackHost ↔ our hostAllowed (which also lets *.ts.net and tailnet addresses in; none of ovis's refusals is one)
            test.fail(true, 'ovis-port bug: hostAllowed() refuses "herdr.localhost:7317" and "[::ffff:127.0.0.1]:7317" (stricter than ovis; no safety impact)')
            for (const host of ['localhost', 'localhost:7317', 'LOCALHOST:5173', 'herdr.localhost:7317', '127.0.0.1:7317', '127.9.9.9', '[::1]:7317', 'localhost.:7317', '[::ffff:127.0.0.1]:7317']) expect(hostAllowed(host), host).toBe(true)
            for (const host of ['app.example.test', 'app.example.test:8443', '192.168.0.10:7317', 'localhost.example.test', '127.0.0.1.example.test', '[fd7a::1]:7317', '', '0.0.0.0:7317', '[::ffff:192.168.0.10]']) expect(hostAllowed(host), host).toBe(false)
            for (const host of ['public.example@localhost:7317', 'localhost/x@public.example', 'localhost:7317/x', 'localhost?x', 'local host', 'localhost:port', 'localhost..', '127.0.0.1@public.example']) expect(hostAllowed(host), host).toBe(false)
        })

        test('knows loopback addresses in every spelling', () => {
            for (const address of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopbackAddress(address)).toBe(true)
            for (const address of ['192.168.0.10', '100.64.0.2', '::ffff:192.168.0.10', 'fd7a::1']) expect(isLoopbackAddress(address)).toBe(false)
        })

        test("grants only on this PC's tailnet name or address, in any case, with a trailing dot or a port", () => {
            // ovis grants the no-login owner only for this PC's own name; we have no such grant. The Host check
            // (hostAllowed) is the nearest rule, and it accepts any tailnet name or address.
            test.fixme(true, 'phoneAccess.ts:94-96 — hostAllowed() accepts any *.ts.net name or tailnet address (it does not know this PC\'s own), so "100.64.0.8" and "[100.64.0.7]" pass')
            for (const host of [`${NODE}:7317`, NODE.toUpperCase(), `${NODE}.`, `${NODE}.:443`, IP, `${IP}:7317`]) expect(hostAllowed(host), host).toBe(true)
            for (const host of [null, 'evil.example', 'evil.example:7317', `${NODE}.evil.example`, 'herdr.example.com:7317', '100.64.0.8', `[${IP}]`, '[fd7a::1]:7317']) expect(hostAllowed(host), String(host)).toBe(false)
        })
    })
})

// ---------------------------------------------------------------- devices

const tempDirs: string[] = []
const tempFile = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-phone-devices-'))
    tempDirs.push(dir)
    return path.join(dir, 'devices.json')
}
test.afterAll(() => {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

test.describe('ovis server/devices.test.ts', () => {
    test.describe('DeviceStore', () => {
        test('pairs with the code once, keeps only a hash, and finds the device by its token', () => {
            // not moved: gated / unconfirmed first-pair (our pair() enrols at once, so a new instance knows the cookie)
            const file = tempFile()
            const store = new PhoneDevices(file)
            const { code } = store.startPairing('drive')
            expect(code).toMatch(/^\d{6}$/)
            expect(store.pair('000000'.replace(/./g, (c) => (c === code[0] ? '1' : c)), 'x')).toEqual({ error: 'wrong_code' }) // a wrong code
            const paired = store.pair(code.slice(0, 3) + ' ' + code.slice(3), 'My phone')
            expect('token' in paired).toBe(true)
            if (!('token' in paired)) return
            expect(store.pair(code, 'again')).toEqual({ error: 'no_code' }) // spent
            expect(store.match(paired.token)).toEqual({ id: paired.device.id, label: 'My phone', role: 'drive' })
            const saved = fs.readFileSync(file, 'utf8')
            expect(saved).not.toContain(paired.token)
            expect(fs.statSync(file).mode & 0o777).toBe(0o600)
            expect(store.match('not-a-token')).toBeNull()
            // and a second store reading the same file knows the device
            expect(new PhoneDevices(file).match(paired.token)?.label).toBe('My phone')
        })

        test('returns the active pairing without changing it', () => {
            let now = 1000
            const store = new PhoneDevices(tempFile(), () => now)
            const pairing = store.startPairing('drive')
            expect(store.activePairing()).toEqual(pairing)
            now = 601000
            expect(store.activePairing()).toEqual(pairing)
            now = 1000
            expect('token' in store.pair(pairing.code, 'Phone')).toBe(true)
            expect(store.activePairing()).toBeNull()
        })

        test('does not return expired or exhausted pairing codes', () => {
            let now = 1000
            const expired = new PhoneDevices(tempFile(), () => now)
            expired.startPairing('drive')
            now = 601001
            expect(expired.activePairing()).toBeNull()

            now = 1000
            const exhausted = new PhoneDevices(tempFile(), () => now)
            const { code } = exhausted.startPairing('drive')
            const wrong = code === '000000' ? '000001' : '000000'
            for (let attempt = 0; attempt < 5; attempt += 1) expect(exhausted.pair(wrong, 'Wrong')).toEqual({ error: 'wrong_code' })
            expect(exhausted.activePairing()).toBeNull()
        })

        test('expires a code after ten minutes and after five wrong tries', () => {
            let now = Date.now()
            const store = new PhoneDevices(tempFile(), () => now)
            const started = now
            const { code } = store.startPairing('drive')
            now = started + 10 * 60_000 + 1
            expect(store.pair(code, 'late')).toEqual({ error: 'no_code' })
            const second = store.startPairing('drive').code
            for (let i = 0; i < 5; i++) expect(store.pair('999999' === second ? '000000' : '999999', 'x')).toEqual({ error: 'wrong_code' })
            expect(store.pair(second, 'x')).toEqual({ error: 'no_code' })
        })

        test("closes only the revoked device's listeners, including late registrations", () => {
            // our onRevoke is one listener told which id (null = all): "late registrations" cannot be moved
            const store = new PhoneDevices(tempFile())
            const a = store.pair(store.startPairing('drive').code, 'A')
            const b = store.pair(store.startPairing('drive').code, 'B')
            if (!('token' in a) || !('token' in b)) throw new Error('pairing failed')
            expect(store.match(a.token)).not.toBeNull()
            expect(store.match(b.token)).not.toBeNull()
            const closed: string[] = []
            store.onRevoke((id) => {
                if (id === a.device.id) closed.push('a')
                if (id === b.device.id) closed.push('b')
            })
            const finished: string[] = []
            const unsubscribe = store.onRevoke(() => finished.push('finished'))
            unsubscribe()
            store.revoke(a.device.id)
            expect(closed).toEqual(['a'])
            expect(finished).toEqual([])
            expect(store.match(b.token)).not.toBeNull()
        })

        test("renames, revokes, and marks the caller's device", () => {
            // not moved: rename (update) and the "current" mark in list(); revocation part only
            const store = new PhoneDevices(tempFile())
            const a = store.pair(store.startPairing('drive').code, 'A')
            const b = store.pair(store.startPairing('drive').code, 'B')
            if (!('token' in a) || !('token' in b)) throw new Error('pairing failed')
            expect(store.revoke(a.device.id)).toBe(true)
            expect(store.revoke(a.device.id)).toBe(false)
            expect(store.match(a.token)).toBeNull()
            expect(store.match(b.token)?.label).toBe('B')
            expect(store.revoke(b.device.id)).toBe(true)
            expect(store.match(b.token)).toBeNull()
        })
    })

    test.describe('revoke all', () => {
        test('revoke all is atomic and stays gated after restart', () => {
            // not moved: gate_closed_at registry, the returned id list, per-id late listener. Moved: effect on devices and restart
            const file = tempFile()
            const store = new PhoneDevices(file)
            const a = store.pair(store.startPairing('drive').code, 'A')
            const b = store.pair(store.startPairing('watch').code, 'B')
            if (!('token' in a) || !('token' in b)) throw new Error('pairing failed')
            store.match(a.token)
            store.match(b.token)
            const closed: Array<string | null> = []
            store.onRevoke((id) => closed.push(id))
            store.revokeAll()
            expect(closed).toEqual([null])
            expect(store.list()).toEqual([])
            expect(store.match(a.token)).toBeNull()
            expect(store.match(b.token)).toBeNull()
            const reloaded = new PhoneDevices(file)
            expect(reloaded.list()).toEqual([])
            expect(reloaded.match(a.token)).toBeNull()
        })

        test('unconfirmed credentials and pending codes are void', () => {
            // moved: a pending code is void after revoke-all (there are no unconfirmed first-pair cookies here)
            const store = new PhoneDevices(tempFile())
            const code = store.startPairing('drive').code
            store.revokeAll()
            expect(store.pair(code, 'Stale code')).toEqual({ error: 'no_code' })
            expect(store.list()).toEqual([])
            const fresh = store.pair(store.startPairing('drive').code, 'Fresh')
            if (!('token' in fresh)) throw new Error('pairing failed')
            expect(store.match(fresh.token)?.label).toBe('Fresh')
        })
    })

    test.describe('labels and owner', () => {
        test('trims labels and falls back', () => {
            // cleanLabel(raw) has a fixed fallback "Phone", no fallback parameter
            test.fixme(true, 'PhoneDevices.ts cleanLabel — fixed fallback "Phone" (a phone list), ovis takes the fallback as an argument ("Device")')
            expect(cleanLabel('  my   phone ')).toBe('my phone')
            expect(cleanLabel('')).toBe('Device')
            expect(cleanLabel(42)).toBe('Device')
            expect(cleanLabel('x'.repeat(80))).toHaveLength(48)
        })

        test("reads the PC's login out of tailscale status", () => {
            // isTaggedNode() is not ported; its two asserts are not moved
            const status = JSON.stringify({ Self: { UserID: 42 }, User: { '42': { LoginName: 'me@example.com' }, '43': { LoginName: 'them@example.com' } } })
            expect(parseTailscaleOwner(status)).toBe('me@example.com')
            expect(parseTailscaleOwner(JSON.stringify({ Self: { UserID: 99 }, User: {} }))).toBeNull()
            // a real id is past 2^53: as a double it becomes ...136 and names nobody (#526)
            expect(parseTailscaleOwner('{"Self":{"UserID":15633668397603135},"User":{"15633668397603135":{"LoginName":"me@example.com"}}}')).toBe('me@example.com')
            expect(parseTailscaleOwner(null)).toBeNull()
            expect(parseTailscaleOwner('nope')).toBeNull()
            // a tagged node's user entry is the node itself: no person's login
            const tagged = JSON.stringify({ Self: { UserID: 7, Tags: ['tag:server'] }, User: { '7': { LoginName: 'pc.tailnet.ts.net' } } })
            expect(parseTailscaleOwner(tagged)).toBeNull()
        })
    })

    test('flushes the last-seen update before it replaces the registry', () => {
        // the fsync spy is not moved; the stored value is
        const file = tempFile()
        let now = Date.now()
        const store = new PhoneDevices(file, () => now)
        const paired = store.pair(store.startPairing('drive').code, 'Phone')
        if (!('token' in paired)) throw new Error('pairing failed')
        const confirmedAt = now
        store.match(paired.token)
        now = confirmedAt + 61_000
        store.match(paired.token)
        expect(new PhoneDevices(file).list()[0]?.lastSeenAt).toBe(new Date(confirmedAt + 61_000).toISOString())
    })

    test('keeps the previous registry intact and the credential valid when a last-seen write fails before rename', () => {
        const file = tempFile()
        let now = Date.now()
        const store = new PhoneDevices(file, () => now)
        const paired = store.pair(store.startPairing('drive').code, 'Phone')
        if (!('token' in paired)) throw new Error('pairing failed')
        const confirmedAt = now
        store.match(paired.token)
        const before = fs.readFileSync(file, 'utf8')
        // a folder nobody can write into: the temp file cannot be created, so the rename never happens
        const dir = path.dirname(file)
        fs.chmodSync(dir, 0o500)
        try {
            now = confirmedAt + 61_000
            expect(store.match(paired.token)).toEqual(paired.device)
        } finally {
            fs.chmodSync(dir, 0o700)
        }
        expect(fs.readdirSync(dir)).toEqual(['devices.json'])
        expect(fs.readFileSync(file, 'utf8')).toBe(before)
        const reopened = new PhoneDevices(file, () => confirmedAt + 62_000)
        expect(reopened.list()[0]?.lastSeenAt).toBe(new Date(confirmedAt).toISOString())
        expect(reopened.match(paired.token)).toEqual(paired.device)
    })
})

// ---------------------------------------------------------------- push

/** A browser-shaped subscription: P-256 public key (65 bytes) and a 16-byte auth secret, base64url. */
function subscriptionFixture(): { endpoint: string; keys: { p256dh: string; auth: string } } {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    return {
        endpoint: `https://push.example/push/${randomBytes(8).toString('hex')}`,
        keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }
    }
}

interface PushRig {
    dir: string
    log: string
    push: PhonePush
    deps: PhonePushDeps
    sent: () => Array<{ endpoint: string; payload: { title: string; body: string; url: string; tag: string } }>
    advance: (ms: number) => void
}

const SAVED_ENV = ['CLIMANGER_TEST_USERDATA', 'CLIMANAGER_PHONE_PUSH_LOG', 'CLIMANAGER_PHONE_FINISH_MIN_MS'] as const
const savedEnv: Record<string, string | undefined> = {}

function pushRig(over: Partial<PhonePushDeps> = {}): PushRig {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ovis-phone-push-'))
    tempDirs.push(dir)
    const log = path.join(dir, 'push.log')
    // the test-mode log stands in for a real push service (PhonePush.sendAll)
    process.env.CLIMANGER_TEST_USERDATA = dir
    process.env.CLIMANAGER_PHONE_PUSH_LOG = log
    let clock = 10_000_000
    const deps: PhonePushDeps = {
        keysFile: path.join(dir, 'vapid.json'),
        subscriptionsFile: path.join(dir, 'push-subscriptions.json'),
        macInUse: () => false,
        session: (id) => ({ name: `claude ${id}`, agent: true }),
        now: () => clock,
        ...over
    }
    return {
        dir,
        log,
        push: new PhonePush(deps),
        deps,
        sent: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []),
        advance: (ms) => {
            clock += ms
        }
    }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20))

test.describe('ovis server/push.test.ts', () => {
    test.beforeEach(() => {
        for (const key of SAVED_ENV) savedEnv[key] = process.env[key]
    })
    test.afterEach(() => {
        for (const key of SAVED_ENV) {
            if (savedEnv[key] === undefined) delete process.env[key]
            else process.env[key] = savedEnv[key]
        }
    })

    test.describe('parseSubscription', () => {
        test("accepts what a browser's PushSubscription.toJSON() produces", () => {
            // the fake's loopback-http endpoint is never accepted here: an https one stands in
            const { push } = pushRig()
            const browserJson = { ...subscriptionFixture(), expirationTime: null }
            expect(push.subscribe(browserJson, 'tailscale:o')).toBe(true)
            expect(push.count()).toBe(1)
        })

        test('rejects endpoints and keys a push service could never have issued', () => {
            test.fail(true, 'ovis-port bug: isSubscription() checks only that keys are strings under a length cap — a 40-char p256dh and auth "AAAA" are accepted')
            const { push } = pushRig()
            const { endpoint, keys } = subscriptionFixture()
            const accepts = (value: unknown): boolean => push.subscribe(value, 'tailscale:o')
            expect(accepts({ endpoint: 'ftp://push.example/x', keys })).toBe(false)
            expect(accepts({ endpoint: 'not a url', keys })).toBe(false)
            expect(accepts({ endpoint, keys: { ...keys, p256dh: keys.p256dh.slice(0, 40) } })).toBe(false)
            expect(accepts({ endpoint, keys: { ...keys, auth: 'AAAA' } })).toBe(false)
            expect(accepts({ endpoint })).toBe(false)
            expect(accepts('subscription')).toBe(false)
            // a plain-http endpoint is never a browser subscription, and it is the shape that
            // would turn the sender into a POST from inside the user's network
            expect(accepts({ endpoint: 'http://169.254.169.254/latest/meta-data/', keys })).toBe(false)
            expect(accepts({ endpoint: 'http://192.168.0.10:9000/push/1', keys })).toBe(false)
        })

        test("refuses http on loopback too, unless the push service was made for the tests' fake", () => {
            // the loopbackHttp option does not exist here (http is always refused); only the refusals and https acceptances move
            const { push } = pushRig()
            const { keys } = subscriptionFixture()
            for (const endpoint of ['http://127.0.0.1:9000/push/1', 'http://[::1]:9000/push/1', 'http://localhost:9000/push/1']) {
                expect(push.subscribe({ endpoint, keys }, 'tailscale:o')).toBe(false)
            }
            expect(push.subscribe({ endpoint: 'https://127.0.0.1:9000/push/1', keys }, 'tailscale:o')).toBe(true)
            expect(push.subscribe({ endpoint: 'https://push.example/x', keys }, 'tailscale:o')).toBe(true)
        })
    })

    test.describe('push state', () => {
        test('keeps one owner-only VAPID key pair across restarts', () => {
            const rig = pushRig()
            const key = rig.push.publicKey()
            expect(Buffer.from(key, 'base64url').length).toBe(65)
            expect(new PhonePush(rig.deps).publicKey()).toBe(key)
            expect(fs.statSync(rig.deps.keysFile).mode & 0o777).toBe(0o600)
        })

        test('refuses a malformed key file instead of rotating the key under every device', () => {
            test.fail(true, 'ovis-port bug: PhonePush.vapid() silently makes a new key pair (and overwrites vapid.json) when the file is malformed — every subscribed phone is orphaned')
            const rig = pushRig()
            fs.writeFileSync(rig.deps.keysFile, '{}\n')
            expect(() => new PhonePush(rig.deps).publicKey()).toThrow('malformed')
            expect(fs.readFileSync(rig.deps.keysFile, 'utf8')).toBe('{}\n')
        })

        test('keeps subscriptions across restarts', async () => {
            const rig = pushRig()
            expect(rig.push.subscribe(subscriptionFixture(), 'tailscale:o')).toBe(true)
            expect(fs.statSync(rig.deps.subscriptionsFile).mode & 0o777).toBe(0o600)
            const restarted = new PhonePush(rig.deps)
            expect(await restarted.test()).toEqual({ status: 'sent', devices: 1 })
            expect(rig.sent()).toHaveLength(1)
        })
    })

    test.describe('push delivery', () => {
        test('forgets a device its push service reports gone', async () => {
            const rig = pushRig()
            // no test-mode log: the real code path, with the push service's answer stubbed
            delete process.env.CLIMANGER_TEST_USERDATA
            const original = webpush.sendNotification
            webpush.sendNotification = (async () => {
                throw Object.assign(new Error('gone'), { statusCode: 410 })
            }) as typeof webpush.sendNotification
            try {
                expect(rig.push.subscribe(subscriptionFixture(), 'tailscale:o')).toBe(true)
                expect((await rig.push.test()).status).toBe('failed')
                expect(JSON.parse(fs.readFileSync(rig.deps.subscriptionsFile, 'utf8')).subscriptions).toEqual([])
                expect(await rig.push.test()).toMatchObject({ status: 'none' })
            } finally {
                webpush.sendNotification = original
            }
        })
    })

    test.describe("alert timing and each device's choice", () => {
        test('tells a finish only after a turn that worked a while, and not one followed by the next prompt', async () => {
            // ovis longTurn 1000 ↔ the finish minimum, set the same through the test-mode override.
            // Not moved: the pending-timer counts (we send at once, there is no wait to call off); the single
            // alert at the end comes from the one-per-minute-per-session gap, not from a cancelled wait.
            process.env.CLIMANAGER_PHONE_FINISH_MIN_MS = '1000'
            const rig = pushRig()
            rig.push.subscribe(subscriptionFixture(), 'tailscale:o')
            rig.push.onStatus([{ sessionId: 'p1', state: 'idle' }])
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            rig.advance(500)
            rig.push.onStatus([{ sessionId: 'p1', state: 'idle' }])
            await settle()
            expect(rig.sent()).toHaveLength(0)
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            rig.advance(2_000)
            rig.push.onStatus([{ sessionId: 'p1', state: 'idle' }])
            // the next prompt went in before the alert: the user is there
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            await settle()
            rig.advance(2_000)
            rig.push.onStatus([{ sessionId: 'p1', state: 'idle' }])
            await settle()
            expect(rig.sent()).toHaveLength(1)
        })

        test('calls off a question answered before it goes out, and sends one left waiting', async () => {
            test.fixme(true, 'PhonePush.ts alert() — an alert goes out at once (no short wait to call off); ovis waits and cancels if the question is answered meanwhile')
            const rig = pushRig()
            rig.push.subscribe(subscriptionFixture(), 'tailscale:o')
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            rig.push.onStatus([{ sessionId: 'p1', state: 'waiting', question: 'ok?' }])
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            await settle()
            expect(rig.sent()).toHaveLength(0)
        })
    })

    test('persists device ownership and refuses revoked and legacy subscriptions after restart', async () => {
        // moved: ownership is stored with the subscription and a revoked owner's subscription is gone for good
        // (forgetOwner); our owner is `device:<id>` in `owner`, not `device_id`. Legacy records do not exist here.
        const rig = pushRig()
        rig.push.subscribe(subscriptionFixture(), 'device:device-a')
        expect(JSON.parse(fs.readFileSync(rig.deps.subscriptionsFile, 'utf8')).subscriptions[0].owner).toBe('device:device-a')
        const restarted = new PhonePush(rig.deps)
        expect(restarted.count()).toBe(1)
        restarted.forgetOwner('device:device-a')
        expect(await restarted.test()).toMatchObject({ status: 'none' })
        expect(rig.sent()).toHaveLength(0)
        expect(new PhonePush(rig.deps).count()).toBe(0)
    })

    test('revoked owner cannot receive queued push', async () => {
        // there is no queue (alerts go out at once), so: after the device is revoked nothing reaches it and the file is empty
        const rig = pushRig()
        const devices = new PhoneDevices(path.join(rig.dir, 'devices.json'))
        const owner = devices.pair(devices.startPairing('drive').code, 'Owner')
        if (!('token' in owner)) throw new Error('pairing failed')
        devices.match(owner.token)
        rig.push.subscribe(subscriptionFixture(), `device:${owner.device.id}`)
        devices.onRevoke((id) => rig.push.forgetOwner(id === null ? null : `device:${id}`))
        devices.revokeAll()
        rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
        rig.push.onStatus([{ sessionId: 'p1', state: 'waiting', question: 'ok?' }])
        await settle()
        expect(rig.sent()).toHaveLength(0)
        expect(JSON.parse(fs.readFileSync(rig.deps.subscriptionsFile, 'utf8')).subscriptions).toEqual([])
    })

    test.describe('a window of the app in use (#751)', () => {
        test('sends no device an alert while some window is in use, and sends again once none is', async () => {
            // texts are ours ("Test alert from your Mac" ...), so the alerts are matched by tag / count
            let inUse = true
            const rig = pushRig({ macInUse: () => inUse })
            rig.push.subscribe(subscriptionFixture(), 'tailscale:o')
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            rig.push.onStatus([{ sessionId: 'p1', state: 'waiting', question: 'ok?' }])
            await settle()
            expect(rig.sent()).toHaveLength(0)
            // the confirmation a device asked for is not an alert: it still goes out
            expect(await rig.push.test()).toEqual({ status: 'sent', devices: 1 })
            expect(rig.sent().map((r) => r.payload.tag)).toEqual(['climanager-test'])
            inUse = false
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            rig.push.onStatus([{ sessionId: 'p1', state: 'waiting', question: 'ok?' }])
            await settle()
            expect(rig.sent().map((r) => r.payload.tag)).toEqual(['climanager-test', 'session-p1'])
        })

        test('asks when the alert would go out, not when the status changed', async () => {
            test.fixme(true, 'PhonePush.ts alert() — macInUse is asked when the status changes, which is when the alert goes out (no wait in between)')
            let inUse = false
            const rig = pushRig({ macInUse: () => inUse })
            rig.push.subscribe(subscriptionFixture(), 'tailscale:o')
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            rig.push.onStatus([{ sessionId: 'p1', state: 'waiting', question: 'ok?' }])
            // the window came forward while the alert waited for its timer
            inUse = true
            await settle()
            expect(rig.sent()).toHaveLength(0)
        })

        test('holds an alert when a window comes into use while its title is looked up', async () => {
            let inUse = false
            const rig = pushRig({
                macInUse: () => inUse,
                session: () => {
                    inUse = true
                    return { name: 'claude', agent: true }
                }
            })
            rig.push.subscribe(subscriptionFixture(), 'tailscale:o')
            rig.push.onStatus([{ sessionId: 'p1', state: 'working' }])
            rig.push.onStatus([{ sessionId: 'p1', state: 'waiting', question: 'ok?' }])
            await settle()
            expect(rig.sent()).toHaveLength(0)
        })
    })
})
