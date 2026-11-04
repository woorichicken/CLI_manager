import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
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
