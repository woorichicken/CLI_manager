import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ChatForkRequest, ConversationTurn } from '../../src/shared/conversation'
import {
    EXCERPT_MAX_CHARS,
    EXCERPT_MAX_TURNS,
    EXCERPT_TURN_MAX_CHARS,
    forkCommand,
    forkFirstMessage,
    forkSessionName,
    FORK_NAME_SUFFIX
} from '../../src/main/chatFork'
import { ConversationService, type ConversationServiceDeps } from '../../src/main/ConversationService'
import { TranscriptReader, claudeProjectSlug } from '../../src/main/TranscriptReader'

/**
 * T116 — Chat «Fork into a new session», without Electron.
 *
 * The start command (`forkCommand`): Claude `--resume <id> --fork-session`, Codex `fork <id>`, the
 * person's own start command (an alias, its options, a preparation before it) kept by the
 * agentCommand.ts rules, the old resume target dropped — and the first message never in the command
 * (it is typed into the agent, so quotes and line breaks reach it as written).
 * The first message (`forkFirstMessage`): the excerpt's turns (the person's words + the final answer
 * text, never the work), its turn and character caps, secrets masked; the quote; nothing for a bare
 * whole fork. The service (`ConversationService.fork`): the turn must still be the one shown, the
 * conversation must be linked, and what it hands to `openFork`.
 */

const ID = '00000000-0000-4000-8000-00000000f016'
const OTHER = '00000000-0000-4000-8000-00000000f017'

const user = (text: string, ts = '2026-11-10T10:00:00.000Z'): ConversationTurn => ({ role: 'user', ts, parts: [{ kind: 'text', text }] })
const reply = (text: string, ts = '2026-11-10T10:00:05.000Z'): ConversationTurn => ({
    role: 'assistant',
    ts,
    parts: [
        { kind: 'text', text: 'Let me look.', phase: 'commentary' },
        { kind: 'tool', name: 'Read', summary: 'src/a.ts', input: '{"file":"src/a.ts"}', output: 'SECRET_TOOL_OUTPUT' },
        { kind: 'text', text }
    ]
})

test.describe('forkCommand', () => {
    const aliases: Record<string, string> = { cldy: 'claude --dangerously-skip-permissions', cdx: 'codex --yolo' }
    const resolve = (name: string): string | undefined => aliases[name]

    test('Claude: the saved start command, its old resume target dropped, then --resume <id> --fork-session', () => {
        expect(forkCommand('claude', 'claude', ID)).toBe(`claude --resume ${ID} --fork-session`)
        expect(forkCommand('claude', undefined, ID)).toBe(`claude --resume ${ID} --fork-session`)
        expect(forkCommand('claude', `cldy --resume ${OTHER}`, ID, resolve)).toBe(`cldy --resume ${ID} --fork-session`)
        expect(forkCommand('claude', `claude --model opus --session-id ${OTHER}`, ID)).toBe(`claude --model opus --resume ${ID} --fork-session`)
        // a template's preparation stays in front of the agent
        expect(forkCommand('claude', 'glm-on && cldy', ID, resolve)).toBe(`glm-on && cldy --resume ${ID} --fork-session`)
    })

    test('Codex: the saved start command, then fork <id>', () => {
        expect(forkCommand('codex', 'codex', ID)).toBe(`codex fork ${ID}`)
        expect(forkCommand('codex', `codex -m gpt-6 resume ${OTHER}`, ID)).toBe(`codex -m gpt-6 fork ${ID}`)
        expect(forkCommand('codex', 'cdx', ID, resolve)).toBe(`cdx fork ${ID}`)
    })

    test('a command it cannot read safely falls back to the agent name; a non-UUID id is refused', () => {
        // a prompt in the saved command would be replayed: the agentCommand.ts fallback types the agent alone
        expect(forkCommand('claude', 'claude -p "do it"', ID)).toBe(`claude --resume ${ID} --fork-session`)
        expect(forkCommand('claude', 'claude $(evil)', ID)).toBe(`claude --resume ${ID} --fork-session`)
        expect(() => forkCommand('claude', 'claude', 'not-a-uuid; rm -rf ~')).toThrow()
        expect(() => forkCommand('codex', 'codex', '')).toThrow()
    })

    test('the new name: «<name> · fork», cut to fit', () => {
        expect(forkSessionName('API refactor')).toBe(`API refactor${FORK_NAME_SUFFIX}`)
        expect(forkSessionName('  ')).toBe(`Session${FORK_NAME_SUFFIX}`)
        const long = forkSessionName('x'.repeat(200), 80)
        expect(long.length).toBe(80)
        expect(long.endsWith(FORK_NAME_SUFFIX)).toBe(true)
    })
})

test.describe('forkFirstMessage', () => {
    const turns: ConversationTurn[] = [
        user('first question'),
        reply('first answer'),
        user('second question'),
        reply('second answer'),
        user('third question'),
        reply('third answer'),
        user('after the fork point'),
        reply('later answer')
    ]
    const base = { turns, agent: 'claude' as const, sourceName: 'API refactor' }

    test('whole without words or quote sends nothing; the words go as written (quotes, line breaks)', () => {
        expect(forkFirstMessage({ ...base, turnIndex: 5, scope: 'whole', message: '   ', quote: false })).toBe('')
        const words = `Try "plan B" — it's 'fine'\nline two\n\n$(not a command) \`nor this\``
        expect(forkFirstMessage({ ...base, turnIndex: 5, scope: 'whole', message: words, quote: false })).toBe(words)
    })

    test('quote: this reply as a Markdown quote above the words', () => {
        const text = forkFirstMessage({ ...base, turnIndex: 3, scope: 'whole', message: 'Go on from here.', quote: true })
        expect(text).toContain('> second answer')
        expect(text.trim().endsWith('Go on from here.')).toBe(true)
        // the final answer only — not the narration, not the tool output
        expect(text).not.toContain('Let me look.')
        expect(text).not.toContain('SECRET_TOOL_OUTPUT')
    })

    test('excerpt: the last turns up to this reply, oldest first, then the words', () => {
        const text = forkFirstMessage({ ...base, turnIndex: 5, scope: 'excerpt', message: 'Now do X.', quote: false })
        for (const words of ['first question', 'first answer', 'second question', 'second answer', 'third question', 'third answer']) expect(text).toContain(words)
        expect(text.indexOf('first question')).toBeLessThan(text.indexOf('third answer'))
        // nothing after the fork point
        expect(text).not.toContain('after the fork point')
        expect(text).not.toContain('later answer')
        expect(text).toContain('API refactor')
        expect(text.trim().endsWith('Now do X.')).toBe(true)
        expect(text).not.toContain('SECRET_TOOL_OUTPUT')
    })

    test('excerpt caps: at most EXCERPT_MAX_TURNS turns, each turn and the whole cut to their caps', () => {
        const many: ConversationTurn[] = []
        for (let i = 0; i < 20; i++) many.push(user(`question ${i}`), reply(`answer ${i}`))
        const text = forkFirstMessage({ turns: many, agent: 'claude', sourceName: 's', turnIndex: many.length - 1, scope: 'excerpt', message: 'go', quote: false })
        const kept = Array.from({ length: 20 }, (_, i) => i).filter((i) => text.includes(`question ${i}\n`) || text.includes(`answer ${i}\n`) || text.includes(`answer ${i}`))
        expect(text).toContain('answer 19')
        expect(text).not.toContain('question 16\n')
        expect(kept.length).toBeLessThanOrEqual(EXCERPT_MAX_TURNS / 2 + 1)

        const huge: ConversationTurn[] = [user('q'.repeat(EXCERPT_TURN_MAX_CHARS * 3)), reply('a'.repeat(EXCERPT_TURN_MAX_CHARS * 3))]
        const big = forkFirstMessage({ turns: huge, agent: 'claude', sourceName: 's', turnIndex: 1, scope: 'excerpt', message: 'go', quote: false })
        expect(big.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS + 1000)
        expect(big.match(/a+/g)!.sort((x, y) => y.length - x.length)[0].length).toBeLessThanOrEqual(EXCERPT_TURN_MAX_CHARS)
        expect(big).toContain('(cut)')
    })

    test('excerpt: secrets in the turns are masked, the person\'s own words are not touched', () => {
        const key = ['sk', 'ant', 'api03', 'a'.repeat(40)].join('-')
        const secretTurns: ConversationTurn[] = [user(`use ${key} for it`), reply(`I set ANTHROPIC_API_KEY=${key} in .env`)]
        const text = forkFirstMessage({ turns: secretTurns, agent: 'claude', sourceName: 's', turnIndex: 1, scope: 'excerpt', message: 'thanks', quote: false })
        expect(text).not.toContain(key)
        expect(text).toContain('[REDACTED]')
    })

    test('excerpt without words still ends with a line for the agent', () => {
        const text = forkFirstMessage({ ...base, turnIndex: 1, scope: 'excerpt', message: '', quote: false })
        expect(text).toContain('first answer')
        expect(text.length).toBeGreaterThan('first answer'.length)
    })
})

test.describe('ConversationService.fork', () => {
    function setup(sessionOverrides: Record<string, unknown> = {}) {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t116-'))
        const cwd = path.join(home, 'project')
        fs.mkdirSync(cwd)
        const claudeDir = path.join(home, 'claude')
        const file = path.join(claudeDir, 'projects', claudeProjectSlug(cwd), `${ID}.jsonl`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const rows: unknown[] = []
        let parent: string | null = null
        const line = (type: 'user' | 'assistant', content: unknown, ts: string): void => {
            const uuid = `u-${rows.length}`
            rows.push({ type, uuid, parentUuid: parent, timestamp: ts, sessionId: ID, cwd, message: { role: type, content } })
            parent = uuid
        }
        line('user', 'first question', '2026-11-10T10:00:00.000Z')
        line('assistant', [{ type: 'text', text: 'first answer' }], '2026-11-10T10:00:05.000Z')
        line('user', 'second question', '2026-11-10T10:01:00.000Z')
        line('assistant', [{ type: 'text', text: 'second answer' }], '2026-11-10T10:01:05.000Z')
        fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
        const calls: unknown[] = []
        const deps: ConversationServiceDeps = {
            session: () => ({ cwd, cliSessionId: ID, cliToolName: 'claude', cliCommand: `cldy --resume ${ID}`, name: 'T116 parent', ...sessionOverrides }),
            reader: new TranscriptReader({ claudeConfigDir: () => claudeDir, codexHome: () => path.join(home, 'codex') }),
            mirror: {
                screen: () => [],
                flush: async () => {},
                lastOutputAt: () => 0,
                hasExited: () => false,
                showsAwaitingInput: () => false,
                inputBox: () => null
            },
            hasTerminal: () => true,
            writeInput: () => {},
            type: async () => true,
            onChange: () => {},
            resolveAlias: (name) => (name === 'cldy' ? 'claude --dangerously-skip-permissions' : undefined),
            openFork: async (input) => {
                calls.push(input)
                return { sessionId: 'new-session', name: input.name, messageSent: input.prompt !== '' }
            }
        }
        return { service: new ConversationService(deps), calls }
    }
    const request = (over: Partial<ChatForkRequest> = {}): ChatForkRequest => ({
        turnIndex: 1,
        turnTs: '2026-11-10T10:00:05.000Z',
        scope: 'whole',
        message: 'Branch here',
        quote: false,
        ...over
    })

    test('whole: the fork command on the saved alias, the person\'s words as the first message', async () => {
        const { service, calls } = setup()
        const result = await service.fork('parent', request())
        expect(result).toEqual({ status: 'forked', sessionId: 'new-session', name: 'T116 parent · fork', messageSent: true })
        expect(calls).toEqual([
            { parentId: 'parent', anchor: { turnTs: '2026-11-10T10:00:05.000Z', turnIndex: 1 }, agent: 'claude', name: 'T116 parent · fork', command: `cldy --resume ${ID} --fork-session`, cliCommand: 'cldy', prompt: 'Branch here', watchCodex: false }
        ])
    })

    test('excerpt: the agent\'s plain start command, and the turns up to that reply in the first message', async () => {
        const { service, calls } = setup()
        await service.fork('parent', request({ scope: 'excerpt' }))
        expect(calls[0]).toMatchObject({ anchor: { turnTs: '2026-11-10T10:00:05.000Z', turnIndex: 1 } })
        const call = calls[0] as { command: string; prompt: string }
        expect(call.command).toBe('cldy')
        expect(call.prompt).toContain('first question')
        expect(call.prompt).toContain('first answer')
        expect(call.prompt).not.toContain('second question')
        expect(call.prompt.trim().endsWith('Branch here')).toBe(true)
    })

    test('no place given (the Control API): the latest reply, and the AI client marks the new session', async () => {
        const { service, calls } = setup()
        const result = await service.fork('parent', { scope: 'excerpt', message: 'go', quote: false }, undefined, { aiClient: 'mcp' })
        expect(result).toMatchObject({ status: 'forked' })
        const call = calls[0] as { prompt: string; aiClient?: string }
        expect(call).toMatchObject({ anchor: { turnTs: '2026-11-10T10:01:05.000Z', turnIndex: 3 } })
        expect(call.aiClient).toBe('mcp')
        // the latest reply is the second answer: the excerpt reaches it
        expect(call.prompt).toContain('second answer')
        // a person's fork from the Chat carries no AI client
        await service.fork('parent', request())
        expect((calls[1] as { aiClient?: string }).aiClient).toBeUndefined()
    })

    test('refused: another turn at that place now, a user turn, no linked conversation, an unknown session', async () => {
        const { service, calls } = setup()
        expect(await service.fork('parent', request({ turnTs: '2026-11-10T09:00:00.000Z' }))).toMatchObject({ status: 'rejected', reason: 'turn_changed' })
        expect(await service.fork('parent', request({ turnIndex: 0, turnTs: '2026-11-10T10:00:00.000Z' }))).toMatchObject({ status: 'rejected', reason: 'turn_changed' })
        expect(await service.fork('parent', request({ turnIndex: 9 }))).toMatchObject({ status: 'rejected', reason: 'turn_changed' })
        expect(await setup({ cliSessionId: undefined }).service.fork('parent', request())).toMatchObject({ status: 'rejected', reason: 'no_conversation' })
        const gone = setup()
        ;(gone.service as unknown as { deps: ConversationServiceDeps }).deps.session = () => null
        expect(await gone.service.fork('parent', request())).toMatchObject({ status: 'rejected', reason: 'unknown_session' })
        expect(calls).toEqual([])
    })

    test('Codex: whole is `codex fork <id>` and asks for the new conversation to be watched; a missing file is refused', async () => {
        const CODEX_ID = '00000000-0000-4000-8000-0000000000c1'
        const missing = setup({ cliToolName: 'codex', cliCommand: 'codex', cliSessionId: CODEX_ID })
        // the Codex file is not there: the turn cannot be checked, so nothing is forked blind
        expect(await missing.service.fork('parent', request())).toMatchObject({ status: 'rejected', reason: 'no_conversation' })
        expect(missing.calls).toEqual([])

        const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t116-codex-'))
        const name = 'rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl'
        fs.mkdirSync(path.join(home, 'sessions', '2026', '11', '03'), { recursive: true })
        fs.copyFileSync(path.join(__dirname, 'fixtures/transcripts/codex', name), path.join(home, 'sessions', '2026', '11', '03', name))
        const reader = new TranscriptReader({ claudeConfigDir: () => path.join(home, 'claude'), codexHome: () => home })
        // the reply's place and time as the view would send them, read by the same reader
        const turns = reader.read('probe', 'codex', CODEX_ID, '/Users/someone/project')!.turns
        const index = turns.findIndex((turn) => turn.role === 'assistant')
        const { service, calls } = setup({ cliToolName: 'codex', cliCommand: 'codex -m gpt-6', cliSessionId: CODEX_ID, cwd: '/Users/someone/project' })
        ;(service as unknown as { deps: ConversationServiceDeps }).deps.reader = reader
        const whole = await service.fork('parent', request({ turnIndex: index, turnTs: turns[index].ts, message: '' }))
        expect(whole).toMatchObject({ status: 'forked', messageSent: false })
        expect(calls[0]).toMatchObject({ agent: 'codex', command: `codex -m gpt-6 fork ${CODEX_ID}`, cliCommand: 'codex -m gpt-6', prompt: '', watchCodex: true })
        expect(calls[0]).toMatchObject({ anchor: { turnTs: turns[index].ts, turnIndex: index } })
        // excerpt starts a plain Codex: the app's own start detection watches it
        await service.fork('parent', request({ turnIndex: index, turnTs: turns[index].ts, scope: 'excerpt' }))
        expect(calls[1]).toMatchObject({ command: 'codex -m gpt-6', watchCodex: false })
        expect((calls[1] as { prompt: string }).prompt).toContain('List the files')
    })
})
