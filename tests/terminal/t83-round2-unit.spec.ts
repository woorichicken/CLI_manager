import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import tls from 'tls'
import { PhonePush } from '../../src/main/phone/PhonePush'
import { ConversationService, type ConversationServiceDeps } from '../../src/main/ConversationService'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { readPrompt } from '../../src/main/promptScreen'

/**
 * T83 — what Codex's second cross-review (2026-11-05, review/codex-xreview2) found still open after
 * round 1: F02 (a device revoked during the service's own awaits), F03 (a queued message follows
 * the conversation it was written in), F04 (a card's Enter only on the option meant), F21 (an alert
 * request has a whole-request deadline). Electron-free units.
 */

const PERMISSION_SCREEN = fs.readFileSync(path.join(__dirname, 'fixtures', 'prompts', 'claude-2.1.312-permission.txt'), 'utf8').replace(/\s+$/, '').split('\n')
const WORKING = ['✻ Working… (esc to interrupt)', '─'.repeat(20), '❯ ', '─'.repeat(20)]
const IDLE = ['─'.repeat(20), '❯ ', '─'.repeat(20)]
const poll = (conversations: ConversationService): Promise<void> => (conversations as unknown as { pollRound(): Promise<void> }).pollRound()

interface FakeTerminal {
    screen(): string[]
    lastOutputAt(): number
    writeInput(id: string, data: string): void
}

function serviceOn(terminal: FakeTerminal, overrides: Partial<ConversationServiceDeps> = {}) {
    const typed: string[] = []
    let cliSessionId = 'c1'
    const deps: ConversationServiceDeps = {
        session: () => ({ cwd: '/w', cliSessionId, cliToolName: 'claude' }),
        reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
        mirror: {
            screen: () => terminal.screen(),
            flush: async () => undefined,
            lastOutputAt: () => terminal.lastOutputAt(),
            hasExited: () => false,
            showsAwaitingInput: () => false,
            inputBox: () => ({ typed: '' })
        },
        hasTerminal: () => true,
        writeInput: (id, data) => terminal.writeInput(id, data),
        type: async (_id, text) => (typed.push(text), true),
        onChange: () => undefined,
        ...overrides
    }
    return {
        conversations: new ConversationService(deps),
        typed,
        deps,
        /** the agent resumed another conversation in the same process (Claude `/resume`) */
        resume: (id: string) => {
            cliSessionId = id
        }
    }
}

/** A terminal that printed long ago (the queue's quiet time is over), with a screen the test sets. */
function quietTerminal() {
    let screen = WORKING
    let outputAt = Date.now() - 20_000
    const state = {
        set screen(lines: string[]) {
            screen = lines
            outputAt += 1
        }
    }
    return { state, terminal: { screen: () => screen, lastOutputAt: () => outputAt, writeInput: () => undefined } }
}

/** A phone device that can be disconnected: `allowed` is what phoneApi's `stillAllowed` answers. */
function device(id = 'abc') {
    let ok = true
    return {
        sender: { origin: `device:${id}`, allowed: () => ok },
        revoke: () => {
            ok = false
        }
    }
}

test.describe('T83 F02 a device disconnected while the Chat service waits types nothing', () => {
    test('send at rest: revoked while the program in front is read — not typed', async () => {
        const phone = device()
        const { conversations, typed } = serviceOn(
            { screen: () => IDLE, lastOutputAt: () => 1, writeInput: () => undefined },
            {
                agentProcess: async () => {
                    phone.revoke()
                    return '4242'
                }
            }
        )
        expect(await conversations.send('s', 'rm -rf build', phone.sender)).toMatchObject({ status: 'rejected', reason: 'revoked' })
        expect(typed).toEqual([])
    })

    test('send while working: revoked during the checks — not queued (the revoke hook already ran)', async () => {
        const phone = device()
        const { conversations, typed } = serviceOn(
            { screen: () => WORKING, lastOutputAt: () => 1, writeInput: () => undefined },
            {
                agentProcess: async () => {
                    phone.revoke()
                    return '4242'
                }
            }
        )
        conversations.subscribe('s')
        expect(await conversations.send('s', 'later', phone.sender)).toMatchObject({ status: 'rejected', reason: 'revoked' })
        expect((await conversations.getConversation('s')).queued).toEqual([])
        expect(typed).toEqual([])
        conversations.unsubscribe('s')
    })

    test('queued, then revoked without the hook reaching it: the queue never types it', async () => {
        const phone = device()
        const { state, terminal } = quietTerminal()
        const { conversations, typed } = serviceOn(terminal, { agentProcess: async () => '4242' })
        expect(await conversations.send('s', 'next step', phone.sender)).toEqual({ status: 'queued' })
        phone.revoke()
        state.screen = IDLE
        await poll(conversations)
        expect(typed).toEqual([])
        expect((await conversations.getConversation('s')).queued).toEqual([])
    })

    test('the typing itself is told who sends: revoked between the checks and the keys, the type step sees it', async () => {
        const phone = device()
        const guards: Array<(() => boolean) | undefined> = []
        const { conversations } = serviceOn(
            { screen: () => IDLE, lastOutputAt: () => 1, writeInput: () => undefined },
            { type: async (_id, _text, allowed) => (guards.push(allowed), true) }
        )
        expect(await conversations.send('s', 'hello', phone.sender)).toEqual({ status: 'sent' })
        expect(guards).toHaveLength(1)
        expect(guards[0]?.()).toBe(true)
        phone.revoke()
        expect(guards[0]?.()).toBe(false)
    })

    test('Send now: revoked while it waits in the lane — not typed', async () => {
        const phone = device()
        let release: () => void = () => undefined
        const blocker = new Promise<void>((resolve) => (release = resolve))
        const { conversations, typed } = serviceOn(
            { screen: () => WORKING, lastOutputAt: () => 1, writeInput: () => undefined },
            { agentProcess: async () => '4242' }
        )
        conversations.subscribe('s')
        expect(await conversations.send('s', 'queued text', phone.sender)).toEqual({ status: 'queued' })
        const [queued] = (await conversations.getConversation('s')).queued
        // something else holds the session's lane (an earlier card answer, say)
        const holding = (conversations as unknown as { inLane(id: string, work: () => Promise<void>): Promise<void> }).inLane('s', () => blocker)
        const pending = conversations.sendQueuedNow('s', queued.id, phone.sender)
        phone.revoke()
        release()
        await holding
        expect(await pending).toMatchObject({ status: 'rejected', reason: 'revoked' })
        expect(typed).toEqual([])
        conversations.unsubscribe('s')
        conversations.cancelQueued('s')
    })

    test('a card answer waiting in the lane: revoked meanwhile — no key goes', async () => {
        const phone = device()
        const writes: string[] = []
        const screen = PERMISSION_SCREEN
        const { conversations } = serviceOn({ screen: () => screen, lastOutputAt: () => 1, writeInput: (_id, data) => writes.push(data) })
        const menu = readPrompt(screen, 'claude')!
        let release: () => void = () => undefined
        const blocker = new Promise<void>((resolve) => (release = resolve))
        const holding = (conversations as unknown as { inLane(id: string, work: () => Promise<void>): Promise<void> }).inLane('s', () => blocker)
        const pending = conversations.answerPrompt('s', { signature: menu.signature, optionIndex: 1 }, phone.sender)
        phone.revoke()
        release()
        await holding
        expect(await pending).toMatchObject({ status: 'rejected', reason: 'revoked' })
        expect(writes).toEqual([])
    })

    test('Stop: revoked while it waits in the lane — no Esc', async () => {
        const phone = device()
        const writes: string[] = []
        const { conversations } = serviceOn({ screen: () => WORKING, lastOutputAt: () => 1, writeInput: (_id, data) => writes.push(data) })
        let release: () => void = () => undefined
        const blocker = new Promise<void>((resolve) => (release = resolve))
        const holding = (conversations as unknown as { inLane(id: string, work: () => Promise<void>): Promise<void> }).inLane('s', () => blocker)
        const pending = conversations.interrupt('s', phone.sender)
        phone.revoke()
        release()
        await holding
        expect(await pending).toMatchObject({ status: 'rejected', reason: 'revoked' })
        expect(writes).toEqual([])
    })

    test('the Mac’s own sends (no sender) are unchanged', async () => {
        const { conversations, typed } = serviceOn({ screen: () => IDLE, lastOutputAt: () => 1, writeInput: () => undefined })
        expect(await conversations.send('s', 'from the Mac')).toEqual({ status: 'sent' })
        expect(typed).toEqual(['from the Mac'])
    })
})

test.describe('T83 F03 a queued message belongs to the conversation it was written in', () => {
    test('the same agent process resumed another conversation (/resume): the queue drops it, never types it there', async () => {
        const { state, terminal } = quietTerminal()
        const { conversations, typed, resume } = serviceOn(terminal, { agentProcess: async () => '4242' })
        conversations.subscribe('s')
        expect(await conversations.send('s', 'continue the refactor in A')).toEqual({ status: 'queued' })
        resume('c2')
        state.screen = IDLE
        await poll(conversations)
        expect(typed).toEqual([])
        expect((await conversations.getConversation('s')).queued).toEqual([])
        conversations.unsubscribe('s')
    })

    test('Send now after the conversation changed: refused and dropped', async () => {
        const { terminal } = quietTerminal()
        const { conversations, typed, resume } = serviceOn(terminal, { agentProcess: async () => '4242' })
        conversations.subscribe('s')
        expect(await conversations.send('s', 'for A')).toEqual({ status: 'queued' })
        const [queued] = (await conversations.getConversation('s')).queued
        resume('c2')
        expect(await conversations.sendQueuedNow('s', queued.id)).toMatchObject({ status: 'rejected', reason: 'conversation_changed' })
        expect(typed).toEqual([])
        expect((await conversations.getConversation('s')).queued).toEqual([])
        conversations.unsubscribe('s')
    })

    test('the same conversation: the queued message goes', async () => {
        const { state, terminal } = quietTerminal()
        const { conversations, typed } = serviceOn(terminal, { agentProcess: async () => '4242' })
        expect(await conversations.send('s', 'next step')).toEqual({ status: 'queued' })
        state.screen = IDLE
        await poll(conversations)
        expect(typed).toEqual(['next step'])
    })
})

/**
 * A permission menu whose "agent" reads each key `keyDelayMs` after it is written (as T82's), and
 * where someone can press a key in the raw terminal too (`rawKey`) — the Mac's own keyboard or the
 * phone's Terminal tab, neither of which goes through the Chat service's lane.
 */
function sharedMenuTerminal(keyDelayMs: number) {
    let selected = 0
    let picked: number | null = null
    let outputAt = 1
    const writes: string[] = []
    const apply = (data: string): void => {
        if (picked !== null) return
        if (data === '\x1b[B') selected = Math.min(3, selected + 1)
        else if (data === '\x1b[A') selected = Math.max(0, selected - 1)
        else if (data === '\r') picked = selected
        outputAt += 1
    }
    const menu = (): string[] =>
        PERMISSION_SCREEN.map((line) => {
            const option = /^ (?:❯| ) (\d)\. (.*)$/.exec(line)
            if (!option) return line
            return `${Number(option[1]) - 1 === selected ? ' ❯' : '  '} ${option[1]}. ${option[2]}`
        })
    return {
        writes,
        picked: () => picked,
        screen: (): string[] => (picked === null ? menu() : IDLE),
        lastOutputAt: () => outputAt,
        writeInput: (_id: string, data: string): void => {
            writes.push(data)
            setTimeout(() => apply(data), keyDelayMs)
        },
        rawKey: (data: string): void => apply(data)
    }
}

test.describe('T83 F04 a card’s Enter goes only while the option it meant is highlighted', () => {
    test('a raw ↓ lands between the card’s ↓ and its Enter: no Enter, prompt_changed', async () => {
        const terminal = sharedMenuTerminal(5)
        const { conversations } = serviceOn({
            ...terminal,
            writeInput: (id, data) => {
                terminal.writeInput(id, data)
                // the person presses ↓ in the terminal right after the card's first key
                if (data === '\x1b[B') setTimeout(() => terminal.rawKey('\x1b[B'), 15)
            }
        })
        const menu = readPrompt(terminal.screen(), 'claude')!
        const result = await conversations.answerPrompt('s', { signature: menu.signature, optionIndex: 1 })
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(result).toMatchObject({ status: 'rejected', reason: 'prompt_changed' })
        expect(terminal.writes).not.toContain('\r')
        expect(terminal.picked()).toBeNull()
    })

    for (const keyDelayMs of [5, 300]) {
        test(`nothing in between: option 3 is picked (agent reads keys after ${keyDelayMs}ms)`, async () => {
            const terminal = sharedMenuTerminal(keyDelayMs)
            const { conversations } = serviceOn(terminal)
            const menu = readPrompt(terminal.screen(), 'claude')!
            expect(await conversations.answerPrompt('s', { signature: menu.signature, optionIndex: 2 })).toEqual({ status: 'answered' })
            await new Promise((resolve) => setTimeout(resolve, keyDelayMs + 100))
            expect(terminal.writes).toEqual(['\x1b[B', '\x1b[B', '\r'])
            expect(terminal.picked()).toBe(2)
        })
    }
})

test.describe('T83 F21 an alert request has a deadline for the whole request, not for each quiet moment', () => {
    /** A self-signed TLS server for 127.0.0.1 (made at run time: no key is committed). */
    function selfSigned(dir: string): { key: Buffer; cert: Buffer } {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1', '-subj', '/CN=127.0.0.1',
            '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' })
        return { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }
    }

    for (const stage of ['headers', 'body'] as const) {
        // headers trickled: never answered → failed. Body trickled after a 201: the service took the
        // alert (sent) — what matters is that the answer does not wait for a body that never ends
        test(`a push service that sends one byte every 200ms of its ${stage} and never ends: Test alert returns within the deadline`, async () => {
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t83-'))
            const timers: NodeJS.Timeout[] = []
            const server = tls.createServer(selfSigned(dir), (socket) => {
                socket.on('error', () => undefined)
                socket.once('data', () => {
                    if (stage === 'body') socket.write('HTTP/1.1 201 Created\r\nTransfer-Encoding: chunked\r\n\r\n')
                    else socket.write('HTTP/1.1 201 Created\r\n')
                    timers.push(setInterval(() => socket.write(stage === 'body' ? '1\r\nx\r\n' : 'X-Slow: y\r\n'), 200))
                })
            })
            await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
            const port = (server.address() as net.AddressInfo).port
            const rejectUnauthorized = process.env.NODE_TLS_REJECT_UNAUTHORIZED
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
            const push = new PhonePush({
                keysFile: path.join(dir, 'keys.json'),
                subscriptionsFile: path.join(dir, 'subs.json'),
                macInUse: () => false,
                session: () => null,
                pushTimeoutMs: 800
            })
            const ecdh = crypto.createECDH('prime256v1')
            ecdh.generateKeys()
            expect(
                push.subscribe(
                    { endpoint: `https://127.0.0.1:${port}/push/abc`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } },
                    'tailscale:owner'
                )
            ).toBe(true)
            try {
                const started = Date.now()
                const result = await Promise.race([push.test(), new Promise((resolve) => setTimeout(() => resolve('still waiting'), 4000))])
                expect(result).toMatchObject({ status: stage === 'headers' ? 'failed' : 'sent' })
                expect(Date.now() - started).toBeLessThan(2500)
            } finally {
                if (rejectUnauthorized === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
                else process.env.NODE_TLS_REJECT_UNAUTHORIZED = rejectUnauthorized
                for (const timer of timers) clearInterval(timer)
                server.close()
            }
        })
    }
})
