import { test, expect } from '@playwright/test'
import { parseClaudeTranscript } from '../../src/main/transcript/claudeTranscript'
import { screenBackground } from '../../src/main/screenLines'

/**
 * T121 — what Claude's terminal shows after a turn, in the chat (fb-1110 a0ba98c4): the turn-end line
 * (`✻ Crunched for 29s · done 2:14 PM`, record `system/turn_duration`), the idle recap (`※ recap: …`,
 * record `system/away_summary`) and the background count on the row under the input box
 * (`⏵⏵ bypass permissions on · 1 shell · ← 1 agent`, screen only). Record shapes as Claude Code 2.1.319
 * writes them (read off a real transcript, words replaced).
 */

let counter = 0
let parent: string | null = null
function record(fields: Record<string, unknown>): string {
    const uuid = `21000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
    const line = JSON.stringify({ uuid, parentUuid: parent, timestamp: new Date(Date.UTC(2026, 10, 10, 5, 14, counter)).toISOString(), sessionId: 's', ...fields })
    parent = uuid
    return line
}
const usage = { input_tokens: 1, output_tokens: 1 }
const prompt = (text: string): string => record({ type: 'user', message: { role: 'user', content: text } })
const answer = (text: string): string => record({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage } })
const stopHooks = (): string => record({ type: 'system', subtype: 'stop_hook_summary', hookCount: 1, hookInfos: [], hookErrors: [], preventedContinuation: false, level: 'suggestion' })
const turnDuration = (ms: number): string => record({ type: 'system', subtype: 'turn_duration', durationMs: ms, messageCount: 3, isMeta: false })
const recap = (text: string): string => record({ type: 'system', subtype: 'away_summary', content: text, isMeta: false })
const informational = (text: string): string => record({ type: 'system', subtype: 'informational', content: text, level: 'notice', isMeta: false })

test.describe('T121 the turn-end line and the recap ride on the answer', () => {
    test.beforeEach(() => {
        counter = 0
        parent = null
    })

    test('turn_duration gives the answer when it ended and how long it took; away_summary its recap', () => {
        const lines = [prompt('정리해 줘'), answer('정리했습니다.'), stopHooks(), turnDuration(29_000), recap('Codex 팀장 세션을 지켜보고 있습니다.')]
        const turns = parseClaudeTranscript(lines.join('\n'))
        expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
        const done = turns[1].done!
        expect(done.ms).toBe(29_000)
        expect(done.at).toBe(JSON.parse(lines[3]).timestamp)
        expect(turns[1].recap).toBe('Codex 팀장 세션을 지켜보고 있습니다.')
        // the answer is still what the chat reads as a settled turn
        expect(turns[1].parts.map((part) => part.kind)).toEqual(['text'])
    })

    test('a notice written between the answer and its end does not take the line', () => {
        const turns = parseClaudeTranscript([prompt('q'), answer('a'), informational('Compacted while idle'), turnDuration(1_500)].join('\n'))
        expect(turns.find((turn) => turn.role === 'assistant')!.done?.ms).toBe(1_500)
    })

    test('after a person writes again, a late record belongs to no answer; each turn keeps its own', () => {
        const turns = parseClaudeTranscript([prompt('one'), answer('first'), turnDuration(1_000), prompt('two'), recap('stray')].join('\n'))
        const answers = turns.filter((turn) => turn.role === 'assistant')
        expect(answers).toHaveLength(1)
        expect(answers[0].done?.ms).toBe(1_000)
        expect(answers[0].recap).toBeUndefined()
        const second = parseClaudeTranscript([prompt('one'), answer('first'), turnDuration(1_000), prompt('two'), answer('second'), turnDuration(2_000)].join('\n'))
        expect(second.filter((turn) => turn.role === 'assistant').map((turn) => turn.done?.ms)).toEqual([1_000, 2_000])
    })

    test('a record without a number or text is left out', () => {
        const turns = parseClaudeTranscript([prompt('q'), answer('a'), record({ type: 'system', subtype: 'turn_duration', durationMs: 'soon' }), recap('   ')].join('\n'))
        expect(turns[1].done).toBeUndefined()
        expect(turns[1].recap).toBeUndefined()
    })
})

test.describe('T121 background count off the screen', () => {
    const rule = '─'.repeat(115)
    // the bottom of the a0ba98c4 report's screen (Claude Code 2.1.319, 115×43)
    const reported = [
        '✻ Crunched for 29s · done 2:14 PM · 1 shell still running',
        '',
        rule,
        '❯',
        rule,
        '  ~/Downloads/brand | branch:main | Opus',
        '  [API 429] | thinking | session:16m | ctx:[###-------]29%',
        '  ⏵⏵ bypass permissions on · 1 shell · ← 1 agent'
    ]

    test('the reported row: one shell, one agent', () => {
        expect(screenBackground(reported)).toEqual({ shells: 1, agents: 1 })
    })

    test('plural counts, shells only, agents only', () => {
        const under = (row: string): string[] => [rule, '❯', rule, row]
        expect(screenBackground(under('  ⏵⏵ accept edits on · 3 shells · ← 2 agents'))).toEqual({ shells: 3, agents: 2 })
        expect(screenBackground(under('  1 shell'))).toEqual({ shells: 1, agents: 0 })
        expect(screenBackground(under('  ? for shortcuts · ← 4 agents'))).toEqual({ shells: 0, agents: 4 })
    })

    test('the same words above the input box are the conversation, not the count; no box, no count', () => {
        expect(screenBackground([...reported.slice(0, 5), '  ⏵⏵ bypass permissions on'])).toBeNull()
        expect(screenBackground(['⏺ I started 2 agents and 1 shell.', '$ '])).toBeNull()
    })
})
