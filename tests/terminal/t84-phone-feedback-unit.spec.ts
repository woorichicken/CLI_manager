import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhoneServer } from '../../src/main/phone/PhoneServer'
import { PHONE_FEEDBACK_MAX_BYTES, type PhoneFeedbackDeps } from '../../src/main/phone/phoneFeedback'
import { FeedbackModeState } from '../../src/main/feedbackMode'
import { PHONE_API, type PhoneMe } from '../../src/shared/phone'
import { FEEDBACK_RELAY_ORIGIN, type FeedbackRelayRequest, type FeedbackTerminalContext } from '../../src/shared/types'
import { phoneFeedbackAvailable, phoneFeedbackExtra, phoneFeedbackPageUrl } from '../../src/renderer/src/phone/feedbackGate'

/**
 * T84 — the feedback widget on the phone page, without Electron.
 *
 * The phone never judges for itself whether the widget may show (behind `adb reverse` its host is
 * localhost too): main knows whether this Mac has feedback mode on, says so in /me, and relays the
 * report through the same FeedbackRelay the desktop uses. These check the gate and the two routes —
 * who may call them, what they refuse, and that a report names the phone and carries no secret.
 */

const INGEST = 'https://abc.supabase.co/functions/v1/dp-agentation-ingest/source-1'
const tmp = (name: string): string => fs.mkdtempSync(path.join(os.tmpdir(), `t84-${name}-`))

async function startServer(feedbackOn: boolean | null) {
    const dir = tmp('server')
    const devices = new PhoneDevices(path.join(dir, 'devices.json'))
    const relayed: FeedbackRelayRequest[] = []
    const contextAsked: Array<string | null> = []
    const mode = { on: feedbackOn === true }
    const feedback: PhoneFeedbackDeps = {
        enabled: () => mode.on,
        appVersion: () => '9.9.9',
        relay: async (request) => {
            relayed.push(request)
            return { status: 201, headers: { 'content-type': 'application/json' }, body: '{"id":"a1"}' }
        },
        terminalContext: async (sessionId): Promise<FeedbackTerminalContext> => {
            contextAsked.push(sessionId)
            return {
                appEvents: [],
                terminal: sessionId === 'S1'
                    ? { sessionId, running: true, size: { cols: 80, rows: 24 }, historyLines: 3, lastOutputAt: null, screen: 'idle', agentStatus: null, events: [], recentLines: ['$ ls', 'sk-***'], maskedCount: 1 }
                    : null
            }
        }
    }
    const server = new PhoneServer({
        devices,
        push: { forgetOwner: () => undefined, publicKey: () => 'key', keysProblem: () => null, count: () => 0, onStatus: () => undefined } as never,
        tailscale: { read: async () => ({ found: false, owner: null, dnsName: null }), peek: () => null } as never,
        staticDir: dir,
        onStateChange: () => undefined,
        statusPoller: { start: () => undefined, stop: () => undefined },
        listSessions: () => ({ sessions: [], sessionFolders: [] }),
        sessionExists: (id: string) => id === 'S1',
        conversation: {} as never,
        saveAttachment: () => ({ status: 'attached', path: '/tmp/x' }) as never,
        maskLine: (text: string) => text,
        recordPhoneInput: () => undefined,
        terminals: { attachRemote: async () => ({ snapshot: '', cols: 80, rows: 24, detach: () => undefined }), writeInput: () => true, events: new EventEmitter() as never },
        subscribeConversation: () => () => undefined,
        ...(feedbackOn === null ? {} : { feedback })
    })
    const state = await server.apply({ enabled: true, port: 0 } as never)
    expect(state.running).toBe(true)
    const base = `http://127.0.0.1:${state.port}`
    return { server, devices, base, relayed, contextAsked, mode, stop: () => server.stop() }
}

function pairDevice(devices: PhoneDevices, role: 'drive' | 'watch'): string {
    const { code } = devices.startPairing(role)
    const result = devices.pair(code, `Galaxy ${role}`)
    if ('error' in result) throw new Error(result.error)
    return `climanager_phone=${result.token}`
}

const relayBody = (url = INGEST, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ url, method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer dp_ingest_x' }, body: '{"comment":"hi"}', ...extra })

async function postRelay(base: string, cookie: string | null, body: string, origin?: string): Promise<Response> {
    return fetch(`${base}${PHONE_API.feedbackRelay}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) },
        body
    })
}

test.describe('T84 phone feedback — the gate main answers in /me', () => {
    test('a paired drive device learns feedback is on, with the app version; off says nothing', async () => {
        const h = await startServer(true)
        try {
            const cookie = pairDevice(h.devices, 'drive')
            const on = (await (await fetch(`${h.base}${PHONE_API.me}`, { headers: { cookie } })).json()) as PhoneMe
            expect(on.access).toBe('full')
            expect(on.access === 'full' && on.feedback).toEqual({ appVersion: '9.9.9' })
            h.mode.on = false
            const off = (await (await fetch(`${h.base}${PHONE_API.me}`, { headers: { cookie } })).json()) as PhoneMe
            expect(off.access === 'full' && 'feedback' in off).toBe(false)
        } finally {
            await h.stop()
        }
    })

    test('a view-only device never gets the widget', async () => {
        const h = await startServer(true)
        try {
            const cookie = pairDevice(h.devices, 'watch')
            const me = (await (await fetch(`${h.base}${PHONE_API.me}`, { headers: { cookie } })).json()) as PhoneMe
            expect(me.access === 'full' && me.role).toBe('watch')
            expect(me.access === 'full' && 'feedback' in me).toBe(false)
        } finally {
            await h.stop()
        }
    })

    test('a server built without feedback (no deps) says nothing either', async () => {
        const h = await startServer(null)
        try {
            const cookie = pairDevice(h.devices, 'drive')
            const me = (await (await fetch(`${h.base}${PHONE_API.me}`, { headers: { cookie } })).json()) as PhoneMe
            expect(me.access === 'full' && 'feedback' in me).toBe(false)
        } finally {
            await h.stop()
        }
    })

    test('the page decides from /me alone, never from its own host', () => {
        expect(phoneFeedbackAvailable({ access: 'full', role: 'drive', via: 'device', feedback: { appVersion: '1' } }, true)).toBe(true)
        // localhost behind adb reverse: still off when main says nothing
        expect(phoneFeedbackAvailable({ access: 'full', role: 'drive', via: 'device' }, true)).toBe(false)
        expect(phoneFeedbackAvailable({ access: 'full', role: 'watch', via: 'device', feedback: { appVersion: '1' } }, true)).toBe(false)
        // a build without URL/KEY: nothing to send with
        expect(phoneFeedbackAvailable({ access: 'full', role: 'drive', via: 'device', feedback: { appVersion: '1' } }, false)).toBe(false)
        expect(phoneFeedbackAvailable({ access: 'none', reason: 'pairing_required' }, true)).toBe(false)
        expect(phoneFeedbackAvailable(null, true)).toBe(false)
    })
})

test.describe('T84 phone feedback — the relay route', () => {
    test('no cookie: 401, nothing relayed', async () => {
        const h = await startServer(true)
        try {
            const response = await postRelay(h.base, null, relayBody())
            expect(response.status).toBe(401)
            expect(h.relayed).toHaveLength(0)
        } finally {
            await h.stop()
        }
    })

    test('a view-only device: 403', async () => {
        const h = await startServer(true)
        try {
            const response = await postRelay(h.base, pairDevice(h.devices, 'watch'), relayBody())
            expect(response.status).toBe(403)
            expect(h.relayed).toHaveLength(0)
        } finally {
            await h.stop()
        }
    })

    test('feedback mode off on the Mac: 403 feedback_off', async () => {
        const h = await startServer(false)
        try {
            const response = await postRelay(h.base, pairDevice(h.devices, 'drive'), relayBody())
            expect(response.status).toBe(403)
            expect(((await response.json()) as { error: string }).error).toBe('feedback_off')
            expect(h.relayed).toHaveLength(0)
        } finally {
            await h.stop()
        }
    })

    test('a URL outside the ingest function: 400, not relayed', async () => {
        const h = await startServer(true)
        try {
            const cookie = pairDevice(h.devices, 'drive')
            for (const url of ['https://evil.example/x', 'https://abc.supabase.co/rest/v1/users', 'http://abc.supabase.co/functions/v1/dp-agentation-ingest/s']) {
                const response = await postRelay(h.base, cookie, relayBody(url))
                expect(response.status, url).toBe(400)
            }
            const badMethod = await postRelay(h.base, cookie, relayBody(INGEST, { method: 'DELETE' }))
            expect(badMethod.status).toBe(400)
            expect(h.relayed).toHaveLength(0)
        } finally {
            await h.stop()
        }
    })

    test('a body over the cap: 413, not relayed', async () => {
        const h = await startServer(true)
        try {
            const huge = relayBody(INGEST, { body: 'x'.repeat(PHONE_FEEDBACK_MAX_BYTES + 1) })
            const response = await postRelay(h.base, pairDevice(h.devices, 'drive'), huge)
            expect(response.status).toBe(413)
            expect(h.relayed).toHaveLength(0)
        } finally {
            await h.stop()
        }
    })

    test('another origin riding the cookie: 403', async () => {
        const h = await startServer(true)
        try {
            const response = await postRelay(h.base, pairDevice(h.devices, 'drive'), relayBody(), 'https://evil.example')
            expect(response.status).toBe(403)
            expect(h.relayed).toHaveLength(0)
        } finally {
            await h.stop()
        }
    })

    test('a drive device with feedback on: relayed as sent, the answer comes back', async () => {
        const h = await startServer(true)
        try {
            const cookie = pairDevice(h.devices, 'drive')
            const response = await postRelay(h.base, cookie, relayBody(), h.base)
            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({ status: 201, headers: { 'content-type': 'application/json' }, body: '{"id":"a1"}' })
            expect(h.relayed).toHaveLength(1)
            expect(h.relayed[0].url).toBe(INGEST)
            expect(h.relayed[0].body).toBe('{"comment":"hi"}')
            // the phone's own cookie never travels on to the ingest
            expect(JSON.stringify(h.relayed[0])).not.toContain('climanager_phone')
        } finally {
            await h.stop()
        }
    })

    test('a device disconnected while its body was still arriving: 401, not relayed', async () => {
        const h = await startServer(true)
        try {
            const { code } = h.devices.startPairing('drive')
            const paired = h.devices.pair(code, 'Galaxy')
            if ('error' in paired) throw new Error(paired.error)
            const slow = new ReadableStream({
                async start(controller) {
                    controller.enqueue(new TextEncoder().encode(relayBody().slice(0, 20)))
                    await new Promise((resolve) => setTimeout(resolve, 150))
                    h.devices.revoke(paired.device.id)
                    controller.enqueue(new TextEncoder().encode(relayBody().slice(20)))
                    controller.close()
                }
            })
            const response = await fetch(`${h.base}${PHONE_API.feedbackRelay}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', cookie: `climanager_phone=${paired.token}` },
                body: slow,
                duplex: 'half'
            } as RequestInit)
            expect(response.status).toBe(401)
            expect(h.relayed).toHaveLength(0)
        } finally {
            await h.stop()
        }
    })
})

test.describe('T84 phone feedback — the terminal the report is about', () => {
    test('the viewed session: masked lines from main; refused without access or with feedback off', async () => {
        const h = await startServer(true)
        try {
            const url = `${h.base}${PHONE_API.feedbackTerminal}?session=S1`
            expect((await fetch(url)).status).toBe(401)
            expect((await fetch(url, { headers: { cookie: pairDevice(h.devices, 'watch') } })).status).toBe(403)
            const cookie = pairDevice(h.devices, 'drive')
            const context = (await (await fetch(url, { headers: { cookie } })).json()) as FeedbackTerminalContext
            expect(context.terminal?.sessionId).toBe('S1')
            expect(context.terminal?.recentLines).toEqual(['$ ls', 'sk-***'])
            // the list screen: no session — app events only
            const none = (await (await fetch(`${h.base}${PHONE_API.feedbackTerminal}`, { headers: { cookie } })).json()) as FeedbackTerminalContext
            expect(none.terminal).toBeNull()
            expect(h.contextAsked).toEqual(['S1', null])
            h.mode.on = false
            expect((await fetch(url, { headers: { cookie } })).status).toBe(403)
        } finally {
            await h.stop()
        }
    })
})

test.describe('T84 phone feedback — what a report carries', () => {
    test('the page URL names the phone and its screen on the allowed host', () => {
        expect(phoneFeedbackPageUrl(null)).toBe(`${FEEDBACK_RELAY_ORIGIN}/phone?screen=list`)
        expect(phoneFeedbackPageUrl('S1')).toBe(`${FEEDBACK_RELAY_ORIGIN}/phone?screen=session`)
        expect(new URL(phoneFeedbackPageUrl('S1')).host).toBe(new URL(FEEDBACK_RELAY_ORIGIN).host)
    })

    test('extra: surface, version, device, session — no login, token or cookie', () => {
        const extra = phoneFeedbackExtra({
            me: { access: 'full', role: 'drive', via: 'device', deviceLabel: 'Galaxy S24', feedback: { appVersion: '1.2.3' } },
            sessionId: 'S1',
            lens: 'chat'
        })
        expect(extra).toEqual({ surface: 'phone', appVersion: '1.2.3', phoneDevice: 'Galaxy S24', phoneVia: 'device', phoneSessionId: 'S1', phoneView: 'chat' })
        const owner = phoneFeedbackExtra({
            me: { access: 'full', role: 'drive', via: 'tailscale', login: 'person@example.com', feedback: { appVersion: '1.2.3' } },
            sessionId: null,
            lens: null
        })
        // the owner's Tailscale login is an email address: it stays on the Mac
        expect(JSON.stringify(owner)).not.toContain('person@example.com')
        expect(owner).toEqual({ surface: 'phone', appVersion: '1.2.3', phoneDevice: null, phoneVia: 'tailscale', phoneSessionId: null, phoneView: null })
    })
})

test.describe('T84 phone feedback — main remembers what the renderer said', () => {
    test('off until the renderer reports; the latest report wins; garbage is off', () => {
        const state = new FeedbackModeState()
        expect(state.enabled()).toBe(false)
        state.report(true)
        expect(state.enabled()).toBe(true)
        state.report(false)
        expect(state.enabled()).toBe(false)
        // whatever arrives over IPC: only `true` turns it on, nothing throws
        state.report('yes')
        expect(state.enabled()).toBe(false)
        state.report(1)
        expect(state.enabled()).toBe(false)
    })
})
