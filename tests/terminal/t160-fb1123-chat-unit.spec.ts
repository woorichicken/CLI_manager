import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseCodexTranscript } from '../../src/main/transcript/codexTranscript'
import { foldMetadata } from '../../src/main/transcript/metadata'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { QUEUED_SEND_QUIET_MS, sendKeyName, sendsQueuedNow } from '../../src/renderer/src/components/ChatView/chatLib'

/**
 * T160 — fb-1123 Chat reports, without Electron.
 *
 * 8a3a326f: a Codex turn that could not run (usage limit) ends with `task_complete.error` — codex-cli 0.166
 * interactive rollouts, measured 2026-11-23 — and older Codex wrote an `error` event. The Chat showed the
 * person's prompts and nothing after them; now the reason is a notice of its own (source `error`), once.
 * 0adc1255: Codex's `/model` writes `thread_settings_applied` at once (no turn_context until the next turn —
 * measured with the real codex-cli 0.171 in a pty, and seen standalone in 0.166 rollouts); the chip follows it.
 * 00c4df83: the send key in the empty box sends the first queued message now — never while an IME composes,
 * never as the tail of a send or of a composition, never over a question card.
 * Records here are synthetic; their shapes copy the measured ones (no real rollout is in the repository).
 */

const LIMIT = 'You’ve hit your usage limit. Upgrade to Pro (https://example.invalid/pro) or try again at Nov 24th, 2026 11:15 PM.'
const at = (s: number): string => new Date(Date.UTC(2026, 10, 23, 1, 0, s)).toISOString()
const jsonl = (records: unknown[]): string => records.map((record) => JSON.stringify(record)).join('\n') + '\n'
const prompt = (s: number, words: string, turn: string): unknown[] => [
    { timestamp: at(s), type: 'event_msg', payload: { type: 'task_started', turn_id: turn, started_at: 1795396583 } },
    { timestamp: at(s), type: 'turn_context', payload: { turn_id: turn, model: 'gpt-6.1-sol', effort: 'xhigh', sandbox_policy: { type: 'danger-full-access' } } },
    // an interactive 0.166 session writes the prompt as a response item (no user_message event)
    { timestamp: at(s), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: words }] } }
]
const failed = (s: number, turn: string, message = LIMIT): unknown => ({
    timestamp: at(s),
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turn, last_agent_message: null, error: { message, codex_error_info: 'usage_limit_exceeded' } }
})

test.describe('T160 8a3a326f a Codex turn that failed', () => {
    test('the usage-limit reason follows the prompt, once per failed turn', () => {
        const turns = parseCodexTranscript(jsonl([
            ...prompt(0, 'What did we decide to submit?', 't1'),
            failed(1, 't1'),
            ...prompt(5, 'Where are we now?', 't2'),
            failed(6, 't2')
        ]))
        expect(turns.map((turn) => [turn.role, turn.parts.map((part) => part.kind)])).toEqual([
            ['user', ['text']],
            ['user', ['notice']],
            ['user', ['text']],
            ['user', ['notice']]
        ])
        expect(turns[1]!.parts[0]).toEqual({ kind: 'notice', text: LIMIT, source: 'error' })
        expect(turns[3]!.ts).toBe(at(6))
    })

    test('an older Codex error event reads the same; one turn carrying both shows it once', () => {
        const old = parseCodexTranscript(jsonl([
            ...prompt(0, 'hello', 't1'),
            { timestamp: at(1), type: 'event_msg', payload: { type: 'error', message: 'unexpected status 402 Payment Required', codex_error_info: 'other' } },
            { timestamp: at(1), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: null } }
        ]))
        expect(old.at(-1)!.parts).toEqual([{ kind: 'notice', text: 'unexpected status 402 Payment Required', source: 'error' }])
        const both = parseCodexTranscript(jsonl([
            ...prompt(0, 'hello', 't1'),
            { timestamp: at(1), type: 'event_msg', payload: { type: 'error', message: LIMIT, codex_error_info: 'usage_limit_exceeded' } },
            failed(1, 't1')
        ]))
        expect(both.filter((turn) => turn.parts.some((part) => part.kind === 'notice'))).toHaveLength(1)
    })

    test('a turn that answered adds no notice; an answer after a failure is a turn of its own', () => {
        const turns = parseCodexTranscript(jsonl([
            ...prompt(0, 'hello', 't1'),
            { timestamp: at(1), type: 'event_msg', payload: { type: 'agent_message', message: 'Hi.', phase: 'final_answer' } },
            { timestamp: at(1), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't1', last_agent_message: 'Hi.' } },
            ...prompt(3, 'again', 't2'),
            failed(4, 't2'),
            ...prompt(8, 'once more', 't3'),
            { timestamp: at(9), type: 'event_msg', payload: { type: 'agent_message', message: 'Back.', phase: 'final_answer' } },
            { timestamp: at(9), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't3', last_agent_message: 'Back.' } }
        ]))
        expect(turns.map((turn) => `${turn.role}:${turn.parts.map((part) => (part.kind === 'text' ? part.text : part.kind)).join('|')}`)).toEqual([
            'user:hello',
            'assistant:Hi.',
            'user:again',
            'user:notice',
            'user:once more',
            'assistant:Back.'
        ])
    })
})

test.describe('T160 0adc1255 the Codex model chip follows /model', () => {
    const settings = (s: number, model: string, effort?: string): unknown => ({
        timestamp: at(s),
        type: 'event_msg',
        payload: { type: 'thread_settings_applied', thread_id: 'x', thread_settings: { model, ...(effort === undefined ? {} : { reasoning_effort: effort }), approval_policy: 'never' } }
    })

    test('thread_settings_applied sets model and effort before any turn; the last of a burst wins', () => {
        let meta = foldMetadata(jsonl([prompt(0, 'x', 't1')[1]]), 'codex', null)
        expect(meta).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh', mode: 'full access' })
        // the burst the real 0.171 wrote for one pick (06:06:39.627 / .639 / .645)
        meta = foldMetadata(jsonl([settings(10, 'gpt-6-luna', 'medium'), settings(10, 'gpt-6-luna', 'xhigh'), settings(10, 'gpt-6-luna', 'medium')]), 'codex', meta)
        expect(meta).toMatchObject({ model: 'gpt-6-luna', effort: 'medium', mode: 'full access' })
        // no reasoning_effort key: the effort stays
        meta = foldMetadata(jsonl([settings(20, 'gpt-6-sol')]), 'codex', meta)
        expect(meta).toMatchObject({ model: 'gpt-6-sol', effort: 'medium' })
    })

    test('the reader picks it up from an appended line, with no new turn', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 't160-codex-'))
        const id = '00000000-0000-4000-8000-0000000c1600'
        const file = path.join(home, 'sessions', '2026', '11', '23', `rollout-2026-11-23T10-00-00-${id}.jsonl`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, jsonl([{ timestamp: at(0), type: 'session_meta', payload: { id, cwd: home } }, ...prompt(0, 'hello', 't1'), failed(1, 't1')]))
        const reader = new TranscriptReader({ claudeConfigDir: () => home, codexHome: () => home })
        expect(reader.read('s', 'codex', id)!.meta).toMatchObject({ model: 'gpt-6.1-sol', effort: 'xhigh' })
        fs.appendFileSync(file, jsonl([settings(30, 'gpt-6.2-astra', 'high')]))
        const after = reader.read('s', 'codex', id)!
        expect(after.changed).toBe(true)
        expect(after.meta).toMatchObject({ model: 'gpt-6.2-astra', effort: 'high' })
    })
})

test.describe('T160 00c4df83 the send key sends the first queued message now', () => {
    const quiet = QUEUED_SEND_QUIET_MS
    const base = { sendKey: true, composing: false, repeat: false, boxEmpty: true, queued: 1, question: false, boxSending: false, sinceSendMs: quiet + 1, sinceCompositionMs: quiet + 1 }

    test('the empty box with something queued: yes', () => {
        expect(sendsQueuedNow(base)).toBe(true)
        expect(sendsQueuedNow({ ...base, queued: 3 })).toBe(true)
    })

    test('never while an IME composes, on a held key, or right after a send or a composition', () => {
        expect(sendsQueuedNow({ ...base, composing: true })).toBe(false)
        expect(sendsQueuedNow({ ...base, repeat: true })).toBe(false)
        // Korean IME's second Enter after the message went: an older queued one must not follow it out
        expect(sendsQueuedNow({ ...base, sinceSendMs: 5 })).toBe(false)
        expect(sendsQueuedNow({ ...base, sinceCompositionMs: 5 })).toBe(false)
        expect(sendsQueuedNow({ ...base, boxSending: true })).toBe(false)
    })

    test('not with words in the box, nothing queued, a question card, or a key that does not send', () => {
        expect(sendsQueuedNow({ ...base, boxEmpty: false })).toBe(false)
        expect(sendsQueuedNow({ ...base, queued: 0 })).toBe(false)
        expect(sendsQueuedNow({ ...base, question: true })).toBe(false)
        expect(sendsQueuedNow({ ...base, sendKey: false })).toBe(false)
    })

    test('the key the queued row names follows the send setting', () => {
        expect(sendKeyName({}, false, true)).toBe('Enter')
        expect(sendKeyName({ enterSends: false }, false, true)).toBe('⌘Enter')
        expect(sendKeyName({ enterSends: false }, false, false)).toBe('Ctrl+Enter')
        // a phone: Return breaks the line unless the phone's own setting makes it send
        expect(sendKeyName({}, true, true)).toBeNull()
        expect(sendKeyName({ returnSendsOnTouch: true }, true, true)).toBe('Return')
    })
})
