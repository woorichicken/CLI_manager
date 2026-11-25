// Ported from ovis (https://github.com/devswha/ovis, 3e51902, MIT, Copyright (c) 2026 devswha) — group H `agy`.
//   server/agy.test.ts (envelope and skill-invocation cases; the SQLite catalog cases are not ported)
//   server/conversation.test.ts «agy» block (2606–2760: ledger turns; paging, activity and DB rewinds are not ported)
//   server/agy-store.test.ts (presence-lock and process-name cases; the Windows scan cache is not ported)
// Inputs and expected values are ovis's. Only the calls are adapted to our names: ovis reads a ledger
// through `transcriptPage("agy-transcript", path)`, we through createAgyTranscriptParser (TranscriptReader
// feeds it the same lines); ovis names locks with agyStoreFromLocks / windowsLockCandidates, we with
// lockedConversation; ovis's process name test goes to isInteractiveAgy.
import { test, expect } from '@playwright/test'
import fs from 'fs'
import path from 'path'
import { createAgyTranscriptParser } from '../../../src/main/transcript/agyTranscript'
import { isInteractiveAgy, lockedConversation } from '../../../src/main/AgySessionSync'
import type { ConversationTurn } from '../../../src/shared/conversation'

const FIXTURES = path.join(__dirname, '../../fixtures/ovis/agy')

/** ovis `parseAgyTranscript(text)` */
function parseAgyTranscript(text: string): ConversationTurn[] {
    const parser = createAgyTranscriptParser()
    parser.write(text.endsWith('\n') ? text : `${text}\n`)
    return parser.snapshot()
}

/** ovis conversation.test.ts `row` — a DONE step unless `extra` says otherwise */
const row = (step_index: number, type: string, content = '', extra = {}) =>
    JSON.stringify({ step_index, type, status: 'DONE', created_at: '2026-01-01T00:00:00Z', content, ...extra }) + '\n'

test.describe('ovis server/agy.test.ts', () => {
    test('keeps the recorded skill invocation without its expanded metadata', () => {
        const fixture = fs.readFileSync(path.join(FIXTURES, 'skill-invocation.jsonl'), 'utf8')
        const turns = parseAgyTranscript(fixture)
        expect(turns.filter(({ role }) => role === 'user').map(({ parts }) => parts)).toEqual([[{ kind: 'text', text: '/probe-skill hello' }]])
    })

    test('keeps raw input when it is not a complete recognized envelope', () => {
        const content = '<USER_REQUEST>\n/probe-skill hello\n</USER_REQUEST>\n<OTHER>raw</OTHER>'
        const turns = parseAgyTranscript(JSON.stringify({ step_index: 0, type: 'USER_INPUT', status: 'DONE', content }))
        expect(turns[0]?.parts).toEqual([{ kind: 'text', text: content }])
    })

    for (const name of ['reads a stable rollback-journal catalog without creating side files', 'reads a checkpointed WAL catalog without recreating missing side files', 'does not recreate a live WAL pair unlinked between its check and open']) {
        test(name, () => {
            test.fixme(true, 'src/main/transcript/agyTranscript.ts:1-4 — the SQLite rewind catalog (agyCatalog) is not ported yet; docs/backlog.md «Antigravity CLI — 남은 것»')
        })
    }
})

test.describe('ovis server/conversation.test.ts — agy ledger', () => {
    test('tracks native turn boundaries without treating each DONE tool step as completion', () => {
        test.fixme(true, 'CLI Manager reads working/idle from the screen (screenLines.screenShowsBusy), not from the ledger — CLAUDE.md «AgySessionSync.ts» line')
    })
    test('does not complete activity from a partial, unadmitted or unfinished planner answer', () => {
        test.fixme(true, 'activity from the ledger is not ported (screen reading instead) — see the test above')
    })

    test('renders native messages, multiple planner calls and independent results without guessed pairing — the prompt', () => {
        const text = row(0, 'USER_INPUT', '<USER_REQUEST>Keep <USER_REQUEST>literal</USER_REQUEST> tags</USER_REQUEST>\n<ADDITIONAL_METADATA>hidden</ADDITIONAL_METADATA>') +
            row(1, 'EPHEMERAL_MESSAGE', 'hidden context') +
            row(2, 'PLANNER_RESPONSE', 'Checking', { tool_calls: [{ name: 'run_command', args: { CommandLine: 'echo fiction' } }, { name: 'view_file', args: { AbsolutePath: '/fiction.txt' } }] }) +
            row(3, 'GENERIC', 'independent output') +
            row(4, 'CHECKPOINT', 'not a result') +
            row(5, 'USER_INPUT', 'next')
        const turns = parseAgyTranscript(text)
        expect(turns[0]!.parts).toEqual([{ kind: 'text', text: 'Keep <USER_REQUEST>literal</USER_REQUEST> tags' }])
        expect(turns[2]!.role).toBe('user')
    })

    test('renders native messages, multiple planner calls and independent results without guessed pairing — the results', () => {
        test.fixme(true, 'agyTranscript.ts turnsOf pairs each GENERIC result with the oldest unanswered call: measured on this Mac\'s agy ledgers 2026-11-25, 934 of 944 planner responses with calls are followed by exactly that many GENERIC steps (ovis-port notes in docs/backlog.md)')
    })

    test('keeps paging and refs stable on append, then rejects them on a DB-only idle rewind', () => {
        test.fixme(true, 'no paging (TranscriptReader reads the whole ledger) and no DB catalog — backlog «Antigravity CLI — 남은 것»')
    })

    test('replays repeated/backward indices and allows database-only rows', () => {
        // the DB-only row (index 2) has no ledger line: nothing is shown for it either way
        let text = row(0, 'USER_INPUT', 'one') + row(1, 'PLANNER_RESPONSE', 'old') + row(3, 'USER_INPUT', 'two') + row(4, 'PLANNER_RESPONSE', 'discard')
        text += row(3, 'USER_INPUT', 'replacement')
        expect(parseAgyTranscript(text).map((t) => t.parts[0])).toEqual([{ kind: 'text', text: 'one' }, { kind: 'text', text: 'old' }, { kind: 'text', text: 'replacement' }])
        text += row(4, 'PLANNER_RESPONSE', 'new')
        text += row(3, 'USER_INPUT', 'equal repeat')
        const warm = parseAgyTranscript(text)
        expect(parseAgyTranscript(text)).toEqual(warm)
        expect(warm.map((t) => t.parts[0])).toEqual([{ kind: 'text', text: 'one' }, { kind: 'text', text: 'old' }, { kind: 'text', text: 'equal repeat' }])
    })

    test('ignores an incomplete tail and does not settle a running row', () => {
        const parser = createAgyTranscriptParser()
        parser.write(row(0, 'USER_INPUT', 'one'))
        const text = row(1, 'PLANNER_RESPONSE', 'complete')
        expect(parser.snapshot(text.slice(0, -3))).toHaveLength(1)
        parser.write(text)
        expect(parser.snapshot()).toHaveLength(2)
        parser.write(row(2, 'PLANNER_RESPONSE', 'unfinished', { status: 'RUNNING' }))
        expect(JSON.stringify(parser.snapshot())).not.toContain('unfinished')
        parser.write(row(2, 'PLANNER_RESPONSE', 'finished'))
        expect(JSON.stringify(parser.snapshot())).toContain('finished')
    })

    for (const name of ['admits a ledger tail when the DB catches up without changing older cursors', 'never resurrects an observed rewind when replacement DB indices precede their ledger rows']) {
        test(name, () => {
            test.fixme(true, 'no DB catalog — backlog «Antigravity CLI — 남은 것»')
        })
    }
})

test.describe('ovis server/agy-store.test.ts', () => {
    test('reads only presence locks as candidates, never another file beside them', () => {
        const root = '/data/agy'
        const lock = '00000000-0000-4000-8000-000000000001.lock'
        const files = [path.join(root, 'presence', lock), path.join(root, 'presence', 'state.json'), path.join(root, 'presence', 'notes.lock')]
        expect(lockedConversation(files, path.join(root, 'presence'))).toBe('00000000-0000-4000-8000-000000000001')
    })

    test('names no candidate when the agent keeps no presence directory', () => {
        expect(lockedConversation([], '/data/agy/presence')).toBeNull()
    })

    test("recognizes the agent's process name as herdr reports it on this platform", () => {
        expect(isInteractiveAgy('agy')).toBe(true)
        expect(isInteractiveAgy('agyx')).toBe(false)
        expect(isInteractiveAgy('bun')).toBe(false)
        expect(isInteractiveAgy('')).toBe(false)
    })

    test("recognizes the agent's process name — a full path", () => {
        test.fixme(true, 'ovis gets the bare name from herdr; AgySessionSync reads `ps` args, where a full path (/usr/local/bin/agy) is the same program — AgySessionSync.ts agyArguments')
    })

    test('updates held lock when the process switches from lock A to lock B on /new or /resume', () => {
        const presence = 'C:/path/presence'
        expect(lockedConversation([`${presence}/00000000-0000-4000-8000-000000000001.lock`], presence)).toBe('00000000-0000-4000-8000-000000000001')
        expect(lockedConversation([`${presence}/00000000-0000-4000-8000-000000000002.lock`], presence)).toBe('00000000-0000-4000-8000-000000000002')
    })

    test('drops held lock when the process releases its session lock without acquiring another', () => {
        test.fixme(true, 'AgySessionSync keeps the last conversation it reported: the stored id is what a restart resumes (index.ts get-session-resume-command)')
    })
})
