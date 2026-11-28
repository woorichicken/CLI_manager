// Ported from ovis (https://github.com/devswha/ovis, 175d24c, MIT, Copyright (c) 2026 devswha) — group I `opencode`.
//   server/opencode.test.ts: «where OpenCode keeps its store», «an OpenCode 1.x session (session/message/part)»,
//   the terminal-title lookup. The 2.x store cases (session_v2 · session_message · session_part · blobs ·
//   pages) and the herdr / home-screen cases are listed as fixme with the reason.
// Inputs and expected values are ovis's. Only the calls are adapted: ovis builds its stores with bun:sqlite,
// we with node:sqlite; ovis reads a session through `opencodeConversation(path, id)` (a page), we through
// `readSession` + `opencodeTurns` / `opencodeMeta` — the same rows, whole (no pages); its `metadata`
// `{ model, reasoning_effort, context }` is our `ConversationMeta` `{ model, effort, context }`.
import { test, expect } from '@playwright/test'
import path from 'path'
import { opencodeDatabasePath, opencodeMeta, opencodeTurns } from '../../../src/main/transcript/opencodeTranscript'
import { image, readSession, sessionsTitled, toolOutput } from '../../../src/main/transcript/opencodeStore'
import type { ConversationPart, ConversationTurn } from '../../../src/shared/conversation'
import { PNG, root, storeV1, T0 } from './opencodeStoreV1'

/** ovis `opencodeConversation(path, id)` as our reader reads it: the whole session's turns and meta. */
export function conversation(file: string, session: string): { turns: ConversationTurn[]; meta: ReturnType<typeof opencodeMeta> } | { kind: string } {
    const read = readSession(file, session)
    if (read.kind !== 'session') return { kind: read.kind }
    return { turns: opencodeTurns(read.messages, read.end), meta: opencodeMeta(read.messages, read.end) }
}

function turnsOf(file: string, session: string): ConversationTurn[] {
    const read = conversation(file, session)
    if (!('turns' in read)) throw new Error(`expected a session, got ${JSON.stringify(read)}`)
    return read.turns
}

const imageBytes = (file: string, session: string, ref: string): Buffer | null => {
    const found = image(file, session, ref)
    return found ? Buffer.from(found.data, 'base64') : null
}

test.describe('ovis server/opencode.test.ts — where OpenCode keeps its store', () => {
    test('follows the paths OpenCode resolves for itself, the same on every platform', () => {
        const home = path.join(root, 'home')
        const data = path.join(root, 'data')
        // OpenCode has no per-platform data dir: macOS and Windows use ~/.local/share too
        expect(opencodeDatabasePath({}, home)).toBe(path.join(home, '.local', 'share', 'opencode', 'opencode.db'))
        expect(opencodeDatabasePath({ XDG_DATA_HOME: data }, home)).toBe(path.join(data, 'opencode', 'opencode.db'))
        // OPENCODE_DB names a file relative to the data dir, or anywhere
        expect(opencodeDatabasePath({ OPENCODE_DB: 'other.db' }, home)).toBe(path.join(home, '.local', 'share', 'opencode', 'other.db'))
        const elsewhere = path.join(root, 'elsewhere', 'x.db')
        expect(opencodeDatabasePath({ OPENCODE_DB: elsewhere, XDG_DATA_HOME: data }, home)).toBe(path.resolve(elsewhere))
        expect(opencodeDatabasePath({ OPENCODE_DB: ':memory:' }, home)).toBeNull()
    })

    test("binds a pane by the session herdr's OpenCode integration reported, and nothing else", () => {
        test.fixme(true, 'src/main/OpencodeSessionSync.ts — no herdr here: a terminal is bound by its process (argv `--session`, the store it holds, its folder, its terminal title), not by a reported id')
    })
})

test.describe('ovis server/opencode.test.ts — an OpenCode 1.x session (session/message/part)', () => {
    test('reads a 1.x store, folding a prompt\'s steps into one answer, and names its model and usage', () => {
        const s = storeV1()
        s.user('first prompt')
        s.assistant(
            [
                { type: 'reasoning', text: 'think it through' },
                { type: 'tool', tool: 'bash', callID: 'call_1', state: { status: 'completed', input: { command: 'echo hi' }, output: 'hi', metadata: { exit: 0 } } }
            ],
            { finish: 'tool-calls' }
        )
        s.assistant([{ type: 'text', text: 'done' }], { finish: 'stop', tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 0 } } })
        const answer = conversation(s.path, s.session)
        if (!('turns' in answer)) throw new Error('no session')
        // ovis also checks its page cursor (null) and history id: we read no pages
        expect(answer.turns.map((turn) => turn.role)).toEqual(['user', 'assistant'])
        expect(answer.turns[0]!.parts).toEqual([{ kind: 'text', text: 'first prompt' }])
        expect(answer.turns[1]!.parts).toEqual([
            { kind: 'thinking', text: 'think it through' },
            { kind: 'tool', name: 'bash', summary: 'echo hi', input: JSON.stringify({ command: 'echo hi' }, null, 2), output: 'hi', state: 'ok' },
            { kind: 'text', text: 'done', phase: 'final_answer' }
        ])
        expect(answer.meta).toEqual({ model: 'deepseek-v4.1-flash', effort: null, context: { used: 116, window: null } })
    })

    test('keeps a picture pasted in a 1.x prompt, and serves it by the ref the page gave it', () => {
        const s = storeV1()
        const id = s.message('user', { agent: 'build' })
        s.part(id, { type: 'text', text: 'look at this' })
        s.part(id, { type: 'file', mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}` })
        const parts = turnsOf(s.path, s.session)[0]!.parts
        expect(parts).toEqual([
            { kind: 'image', media_type: 'image/png', ref: `opencode:${id}:0` },
            { kind: 'text', text: 'look at this' }
        ])
        expect(imageBytes(s.path, s.session, `opencode:${id}:0`)!.equals(PNG)).toBe(true)
    })

    test("serves a 1.x tool's cut output and its picture by the refs the page gave them", () => {
        const s = storeV1()
        s.user('read it')
        const step = s.assistant(
            [
                { type: 'text', text: 'reading' },
                {
                    type: 'tool',
                    tool: 'read',
                    callID: 'call_1',
                    state: {
                        status: 'completed',
                        input: { filePath: 'big.log' },
                        output: 'y'.repeat(5000),
                        attachments: [{ type: 'file', mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}` }]
                    }
                }
            ],
            { finish: 'stop' }
        )
        const tool = turnsOf(s.path, s.session)
            .flatMap((turn) => turn.parts)
            .find((part): part is Extract<ConversationPart, { kind: 'tool' }> => part.kind === 'tool')!
        expect(tool.output_ref).toBe(`${step}:1`)
        expect(tool.output_size).toBe(5000)
        expect(toolOutput(s.path, s.session, tool.output_ref!)).toBe('y'.repeat(5000))
        expect(toolOutput(s.path, s.session, `${step}:0`)).toBeNull()
        expect(image(s.path, s.session, tool.images![0]!.ref)?.mediaType).toBe('image/png')
        expect(imageBytes(s.path, s.session, tool.images![0]!.ref)!.equals(PNG)).toBe(true)
    })

    test("shows a 1.x step's error and keeps the terminal for a session the store does not hold", () => {
        const s = storeV1()
        s.user('go')
        s.assistant([{ type: 'tool', tool: 'edit', callID: 'call_1', state: { status: 'error', input: { filePath: 'x' }, error: 'No changes to apply: oldString and newString are identical.' } }], {
            finish: 'stop',
            error: { name: 'ProviderError', data: { message: 'Rate limited' } }
        })
        const turns = turnsOf(s.path, s.session)
        const parts = turns[1]!.parts as Extract<ConversationPart, { kind: 'tool' }>[]
        expect(parts[0]!.error).toBe(true)
        expect(parts[0]!.output).toBe('No changes to apply: oldString and newString are identical.')
        expect(turns[1]!.parts).toContainEqual({ kind: 'text', text: 'Error: Rate limited', phase: 'final_answer' })
        // ovis: `{ kind: "unavailable", reason: "session_not_found" }`
        expect(conversation(s.path, 'ses_missing')).toEqual({ kind: 'missing' })
    })

    test('pages a 1.x session by prompt, and the pages meet exactly', () => {
        test.fixme(true, 'src/main/transcript/opencodeStore.ts readSession — a session is read whole (up to MAX_SESSION_ROWS); the Chat keeps its newest turns (ConversationService CHAT_TURN_LIMIT), it does not page the store')
    })

    test('hides a reverted 1.x suffix from the pages and from the row references', () => {
        const s = storeV1()
        for (let n = 0; n < 51; n++) {
            s.user(`p${n}`)
            s.assistant([{ type: 'text', text: `a${n}` }], { finish: 'stop' })
        }
        const step = s.assistant(
            [
                { type: 'text', text: 'reading' },
                {
                    type: 'tool',
                    tool: 'read',
                    callID: 'call_1',
                    state: {
                        status: 'completed',
                        input: { filePath: 'big.log' },
                        output: 'y'.repeat(5000),
                        attachments: [{ type: 'file', mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}` }]
                    }
                }
            ],
            { finish: 'stop' }
        )
        const later = s.user('after undo')
        s.part(later, { type: 'file', mime: 'image/png', url: `data:image/png;base64,${PNG.toString('base64')}` })

        const tool = turnsOf(s.path, s.session)
            .flatMap((turn) => turn.parts)
            .find((part): part is Extract<ConversationPart, { kind: 'tool' }> => part.kind === 'tool')!
        expect(tool.output_ref).toBe(`${step}:1`)
        expect(toolOutput(s.path, s.session, tool.output_ref!)).toBe('y'.repeat(5000))
        expect(image(s.path, s.session, tool.images![0]!.ref)).not.toBeNull()

        s.db.prepare('UPDATE session SET revert = ? WHERE id = ?').run(JSON.stringify({ messageID: step }), s.session)

        // ovis reads the newest page and the one before it: we read the whole session
        const parts = turnsOf(s.path, s.session).flatMap((turn) => turn.parts)
        expect(parts.some((part) => part.kind === 'tool')).toBe(false)
        expect(parts.some((part) => part.kind === 'text' && part.text === 'after undo')).toBe(false)
        expect(parts.some((part) => part.kind === 'image' && part.ref === `opencode:${later}:0`)).toBe(false)
        expect(toolOutput(s.path, s.session, tool.output_ref!)).toBeNull()
        expect(image(s.path, s.session, tool.images![0]!.ref)).toBeNull()
    })

    test('leaves an oversized 1.x session to the terminal instead of loading it whole', () => {
        const s = storeV1()
        s.db.exec('BEGIN')
        for (let n = 0; n < 5001; n++) s.user(`p${n}`)
        s.db.exec('COMMIT')
        // ovis: `{ kind: "unavailable", reason: "transcript_missing" }`
        expect(conversation(s.path, s.session)).toEqual({ kind: 'too_large' })
    })
})

test.describe('ovis server/opencode.test.ts — the terminal title', () => {
    test('finds every session whose terminal title OpenCode would make this one, as it cuts a long title, in a 2.x or 1.x store', () => {
        // ovis builds the cut-title cases in a 2.x store; the same rows in a 1.x store here (2.x is not read)
        const s = storeV1('ses_titled1')
        s.db.prepare("UPDATE session SET title = 'Test' WHERE id = 'ses_titled1'").run()
        const add = (id: string, title: string) =>
            s.db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES (?, 'global', 'slug', ?, ?, '1.18.32', ?, ?)").run(id, root, title, T0, T0)
        add('ses_long1', 'Review the long pull request about the relay')
        add('ses_long2', 'Review the long pull request about the release')
        add('ses_short1', 'Review the long pull request about th')
        expect(sessionsTitled(s.path, 'OC | Test')).toEqual(['ses_titled1'])
        expect(sessionsTitled(s.path, 'OC | Review the long pull request about th').sort()).toEqual(['ses_short1'])
        expect(sessionsTitled(s.path, 'OC | Review the long pull request about th…').sort()).toEqual(['ses_long1', 'ses_long2'])
        expect(sessionsTitled(s.path, 'OpenCode')).toEqual([])
        expect(sessionsTitled(storeV1('ses_old2').path, 'OC | Old')).toEqual(['ses_old2'])
        expect(sessionsTitled(path.join(root, 'absent.db'), 'OC | Test')).toEqual([])
        expect(sessionsTitled(null, 'OC | Test')).toEqual([])
    })
})

// The 2.x cases: OpenCode 2.x keeps conversations in `session_v2` / `session_message` (+ `session_part`,
// blobs) and runs a background service; this Mac runs 1.18.15, and a store with `session_v2` is left to
// the terminal (src/main/transcript/opencodeStore.ts withStore).
const V2 = 'src/main/transcript/opencodeStore.ts withStore — the OpenCode 2.x store (session_v2) is not read; this Mac runs 1.18.15 (docs/backlog.md «opencode 2차»)'
const V2_CASES = [
    "OpenCode's rows as a conversation › folds a prompt's steps, with their thinking, tools and outputs, into one answer",
    "OpenCode's rows as a conversation › shows a prompt as typed, with its pasted images and the skills it mentions",
    "OpenCode's rows as a conversation › marks failed tools, names skills and searches, and cuts a long output with a way to fetch it",
    "OpenCode's rows as a conversation › records each call's outcome as OpenCode does: waiting or running, completed, failed",
    "OpenCode's rows as a conversation › reads a call whose input OpenCode 2 is still streaming as not answered yet, so it never stands for the list",
    "OpenCode's rows as a conversation › offers a tool's pictures by their place among the message's images",
    "OpenCode's rows as a conversation › says why a step failed, but not that Esc interrupted it",
    "OpenCode's rows as a conversation › puts what woke the model in the user's seat, and keeps a finished answer apart from the work after it",
    "OpenCode's rows as a conversation › draws a subagent that failed or was cancelled as such, and a foreground one's answer without OpenCode's tag",
    "OpenCode's rows as a conversation › shows a command the user ran once, with its output, and leaves instructions and switches out",
    "OpenCode's rows as a conversation › marks where the conversation was compacted",
    'a page of an OpenCode session (17 cases: pages, cursors, caches, row sizes)',
    'OpenCode 2.4 split assistant content (8 cases)',
    'where a page starts (5 cases)',
    'what a page refers to (2 cases)'
]
test.describe('ovis server/opencode.test.ts — OpenCode 2.x', () => {
    for (const name of V2_CASES) {
        test(name, () => {
            test.fixme(true, V2)
        })
    }
    test('an OpenCode at its home screen, before its first prompt (#3600)', () => {
        test.fixme(true, 'src/main/OpencodeSessionSync.ts — a terminal is bound once OpenCode has written its session (the first prompt); a home screen is no conversation yet, as for Claude and Codex')
    })
})
