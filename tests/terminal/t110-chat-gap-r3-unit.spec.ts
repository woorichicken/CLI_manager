import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { parseCodexTranscript } from '../../src/main/transcript/codexTranscript'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { ConversationService, type ConversationServiceDeps } from '../../src/main/ConversationService'
import type { ConversationPart, ToolPart } from '../../src/shared/conversation'
import { workBlockStartsOpen } from '../../src/renderer/src/components/ChatView/workBlocks'
import { INTERRUPTED_TEXT } from '../../src/renderer/src/components/ChatView/chatLib'

/**
 * T110 — Chat gaps, round 3, without Electron (chat-gap-r3-1109).
 *
 * C-1 the «Collapse work» rule (fb 4c6ea086): with it on (the default) every work block starts folded,
 * the running one too; only the block that waits on the person opens. Off: ovis's old rule.
 * C-5 a Codex `exec` call names the commands its script runs (recorded rollouts: 498 of 539 exec calls run
 * `tools.exec_command({cmd:"…"})`). C-6 a Codex turn the person stopped (`turn_aborted`) reads as stopped.
 * New 1: a Codex session whose conversation file does not exist yet (Codex writes it with the first
 * message) reads as «no turns yet», and a message can be sent. New 2: the Chat's send asks the stricter
 * question test (`asksQuestion`) — words like «Yes, proceed» in the agent's own output above its input box
 * do not block it — while the API's `showsAwaitingInput` stays as it was (T66 keeps that on purpose).
 */

const text = (value: string): ConversationPart => ({ kind: 'text', text: value })
const tool = (name: string): ConversationPart => ({ kind: 'tool', name, summary: name, input: '{}', output: '' })

test.describe('T110 C-1 Collapse work', () => {
    const parts: ConversationPart[] = [tool('Bash'), text('Done.')]
    const commentaryAfter: ConversationPart[] = [text('Done.'), { kind: 'text', text: 'one more thing', phase: 'commentary' }]

    test('on: every block starts folded, the running one included', () => {
        expect(workBlockStartsOpen({ live: true, waiting: false, last: true }, parts, true)).toBe(false)
        expect(workBlockStartsOpen({ live: false, waiting: false, last: true }, commentaryAfter, true)).toBe(false)
        expect(workBlockStartsOpen({ live: false, waiting: false, last: false }, parts, true)).toBe(false)
    })

    test('on: the block that waits on the person opens', () => {
        expect(workBlockStartsOpen({ live: true, waiting: true, last: true }, parts, true)).toBe(true)
    })

    test('off: the running block opens, a settled turn opens its last block only for words after its answer', () => {
        expect(workBlockStartsOpen({ live: true, waiting: false, last: true }, parts, false)).toBe(true)
        expect(workBlockStartsOpen({ live: false, waiting: false, last: true }, parts, false)).toBe(false)
        expect(workBlockStartsOpen({ live: false, waiting: false, last: true }, commentaryAfter, false)).toBe(true)
        expect(workBlockStartsOpen({ live: false, waiting: false, last: false }, commentaryAfter, false)).toBe(false)
    })
})

const line = (record: Record<string, unknown>): string => JSON.stringify(record)
const TS = '2026-11-09T10:00:00.000Z'
const rollout = (...records: Record<string, unknown>[]): string =>
    [
        line({ timestamp: TS, type: 'session_meta', payload: { id: '00000000-0000-4000-8000-00000000r310', cwd: '/w', timestamp: TS } }),
        line({ timestamp: TS, type: 'event_msg', payload: { type: 'task_started', turn_id: 't1', started_at: 1794186827 } }),
        line({ timestamp: TS, type: 'event_msg', payload: { type: 'user_message', message: 'go', kind: 'plain' } }),
        ...records.map(line)
    ].join('\n') + '\n'
const execCall = (input: string, callId = 'call-1'): Record<string, unknown> => ({
    timestamp: TS,
    type: 'response_item',
    payload: { type: 'custom_tool_call', name: 'exec', call_id: callId, status: 'completed', input }
})
const toolsOf = (source: string): ToolPart[] =>
    parseCodexTranscript(source).flatMap((turn) => turn.parts).filter((part): part is ToolPart => part.kind === 'tool')

test.describe('T110 C-5 a Codex exec call names its commands', () => {
    test('one command: the command', () => {
        const [call] = toolsOf(rollout(execCall('text(await tools.exec_command({cmd:"git status --short",max_output_tokens:1500}));\n')))
        expect([call.name, call.summary]).toEqual(['exec', 'git status --short'])
    })

    test('several commands: the first and how many more', () => {
        const script = [
            'const r = await Promise.allSettled([',
            '  tools.exec_command({cmd:"cat docs/a.md",max_output_tokens:16000}),',
            '  tools.exec_command({cmd:"cat docs/b.md",max_output_tokens:14000}),',
            '  tools.exec_command({ cmd: \'ls -la\' })',
            ']); for(let i=0;i<r.length;i++) text({i,...r[i]});'
        ].join('\n')
        const [call] = toolsOf(rollout(execCall(script)))
        expect(call.summary).toBe('cat docs/a.md (+2 more)')
    })

    test('an escaped quote in the command is read as the command has it', () => {
        const [call] = toolsOf(rollout(execCall('text(await tools.exec_command({cmd:"grep -n \\"a b\\" x.ts"}));')))
        expect(call.summary).toBe('grep -n "a b" x.ts')
    })

    test('no command: the tools it calls, else its first line — never the bare name', () => {
        const [stdin] = toolsOf(rollout(execCall('text(await tools.write_stdin({session_id:89164,chars:"",yield_time_ms:1000}));')))
        expect(stdin.summary).toBe('write_stdin')
        const [loop] = toolsOf(rollout(execCall('const cwd="/w";\nfor (const c of ["git fetch", "git merge"]) text(c);')))
        expect(loop.summary).toBe('const cwd="/w";')
    })

    test('a patch in an exec script still names its files (unchanged)', () => {
        const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch'
        const [call] = toolsOf(rollout(execCall(`text(await tools.apply_patch(${JSON.stringify(patch)}));`)))
        expect(call.summary).toBe('src/a.ts')
    })
})

test.describe('T110 C-6 a stopped Codex turn', () => {
    test('turn_aborted reads as the person stopping it, after the turn, which is over', () => {
        const turns = parseCodexTranscript(
            rollout(
                execCall('text(await tools.exec_command({cmd:"sleep 30"}));'),
                { timestamp: '2026-11-09T10:00:05.000Z', type: 'event_msg', payload: { type: 'turn_aborted', turn_id: 't1', reason: 'interrupted', duration_ms: 5000 } }
            )
        )
        const assistant = turns.findLast((turn) => turn.role === 'assistant')
        expect(assistant?.end_ts).toBe('2026-11-09T10:00:05.000Z')
        const last = turns.at(-1)!
        expect(last.role).toBe('user')
        const marker = last.parts[0]
        expect(marker.kind === 'text' && INTERRUPTED_TEXT.test(marker.text)).toBe(true)
    })

    test('a turn that completed shows no stop', () => {
        const turns = parseCodexTranscript(
            rollout(
                { timestamp: TS, type: 'event_msg', payload: { type: 'agent_message', message: 'Done.', phase: 'final_answer' } },
                { timestamp: TS, type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1' } }
            )
        )
        expect(turns.at(-1)!.role).toBe('assistant')
        expect(JSON.stringify(turns)).not.toContain('interrupted')
    })
})

function fakeTerminals() {
    const events = new EventEmitter()
    return { events, getSize: () => ({ cols: 100, rows: 30 }), hasTerminal: () => true }
}

async function mirrorShowing(screen: string): Promise<TerminalMirror> {
    const terminals = fakeTerminals()
    const mirror = new TerminalMirror(terminals as never)
    terminals.events.emit('created', 's1', 100, 30)
    terminals.events.emit('output', 's1', screen.replace(/\n/g, '\r\n'))
    await mirror.flush('s1')
    return mirror
}

const RULE = '─'.repeat(98)
/** Claude Code at rest: its answer said «Yes, proceed», and the input box is below it, empty. */
const OUTPUT_SAYS_PROCEED = ['⏺ Echo: Yes, proceed', '', RULE, '❯ ', RULE, '  ⏵⏵ accept edits on'].join('\n')
const REAL_PERMISSION = [
    '● Bash(rm -rf build)',
    '╭──────────────────────────────────────────────╮',
    '│ Bash command                                 │',
    '│   rm -rf build                               │',
    '│ Do you want to proceed?                      │',
    '│ ❯ 1. Yes, proceed                            │',
    '│   2. No, and tell Claude what to do differently │',
    '╰──────────────────────────────────────────────╯'
].join('\n')

test.describe('T110 new 2 the Chat send asks the stricter question test', () => {
    test('dialog words in the output above the input box: the API still says waiting, the Chat does not', async () => {
        const mirror = await mirrorShowing(OUTPUT_SAYS_PROCEED)
        expect(mirror.showsAwaitingInput('s1'), 'the API guard is unchanged (T66)').toBe(true)
        expect(mirror.asksQuestion('s1')).toBe(false)
    })

    test('a real permission prompt: both say waiting', async () => {
        const mirror = await mirrorShowing(REAL_PERMISSION)
        expect(mirror.showsAwaitingInput('s1')).toBe(true)
        expect(mirror.asksQuestion('s1')).toBe(true)
    })

    test('ConversationService sends from the Chat past output words, and still refuses a real question', async () => {
        for (const [screen, expected] of [
            [OUTPUT_SAYS_PROCEED, 'sent'],
            [REAL_PERMISSION, 'rejected']
        ] as const) {
            const mirror = await mirrorShowing(screen)
            const typed: string[] = []
            const service = new ConversationService(deps(mirror, typed, { cwd: '/w', cliSessionId: 'c1', cliToolName: 'claude' }))
            const result = await service.send('s1', 'next please')
            expect(result.status, screen.slice(0, 30)).toBe(expected)
            expect(typed).toEqual(expected === 'sent' ? ['next please'] : [])
        }
    })
})

function deps(mirror: TerminalMirror, typed: string[], info: { cwd?: string; cliSessionId?: string; cliToolName?: string }): ConversationServiceDeps {
    return {
        session: () => info,
        reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
        mirror,
        hasTerminal: () => true,
        writeInput: () => undefined,
        type: async (_id, value) => (typed.push(value), true),
        onChange: () => undefined
    }
}

test.describe('T110 new 1 a Codex session before its first message', () => {
    test('known to run Codex, no conversation file yet: «no turns yet» from Codex, and a message goes', async () => {
        const mirror = await mirrorShowing(['>_ OpenAI Codex (mock)', '', '› ', '  ? for shortcuts'].join('\n'))
        const typed: string[] = []
        const service = new ConversationService(deps(mirror, typed, { cwd: '/w', cliToolName: 'codex' }))
        const snapshot = await service.getConversation('s1')
        expect([snapshot.agent, snapshot.unavailable]).toEqual(['codex', 'not-found'])
        expect((await service.send('s1', 'first words')).status).toBe('sent')
        expect(typed).toEqual(['first words'])
    })

    test('no agent at all: still «no conversation»', async () => {
        const mirror = await mirrorShowing('$ ')
        const service = new ConversationService(deps(mirror, [], { cwd: '/w' }))
        const snapshot = await service.getConversation('s1')
        expect([snapshot.agent, snapshot.unavailable]).toEqual([null, 'no-conversation'])
    })
})
