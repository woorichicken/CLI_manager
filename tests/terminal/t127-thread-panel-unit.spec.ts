import { test, expect } from '@playwright/test'
import type { ChatThread, ConversationSnapshot, ConversationTurn } from '../../src/shared/conversation'
import { parseClaudeTranscript } from '../../src/main/transcript/claudeTranscript'
import { parseCodexTranscript } from '../../src/main/transcript/codexTranscript'
import { hasEarlierThreadReplies, replyForThread, threadQuote, threadStatus, turnsAfterFork } from '../../src/renderer/src/components/ChatView/threadTurns'

const FORKED_AT = Date.parse('2026-11-14T10:01:00.000Z')
const copiedAndNew = [
    { role: 'user', text: 'Parent question', ts: '2026-11-14T09:59:55.000Z' },
    { role: 'assistant', text: 'The anchor answer', ts: '2026-11-14T10:00:00.000Z' },
    { role: 'user', text: 'Parent question after the anchor', ts: '2026-11-14T10:00:30.000Z' },
    { role: 'assistant', text: 'Parent answer after the anchor', ts: '2026-11-14T10:00:35.000Z' },
    { role: 'user', text: 'Thread question', ts: '2026-11-14T10:01:00.000Z' },
    { role: 'assistant', text: 'Thread answer', ts: '2026-11-14T10:01:05.000Z' }
] as const

const textOf = (turn: ConversationTurn): string => turn.parts.flatMap((part) => part.kind === 'text' ? [part.text] : []).join('\n')

const snapshotOf = (turns: ConversationTurn[], totalTurns = turns.length): ConversationSnapshot => ({
    sessionId: 'thread', agent: 'claude', turns, totalTurns, truncated: false,
    working: false, prompt: null, queued: [], meta: null, revision: 1
})

test('T127 thread panel: Claude copied parent turns keep their original times, even after the anchor', () => {
    const records = copiedAndNew.map((entry, index) => ({
        type: entry.role,
        uuid: `copy-${index}`,
        parentUuid: index === 0 ? null : `copy-${index - 1}`,
        sessionId: 'new-thread-conversation',
        timestamp: entry.ts,
        message: { role: entry.role, content: entry.role === 'user' ? entry.text : [{ type: 'text', text: entry.text }] }
    }))
    const turns = parseClaudeTranscript(records.map((record) => JSON.stringify(record)).join('\n'))
    expect(turns.map(textOf)).toEqual(copiedAndNew.map((entry) => entry.text))
    const shown = turnsAfterFork(turns, FORKED_AT)
    expect(shown.map(textOf)).toEqual(['Thread question', 'Thread answer'])
    // Filtering does not change the source snapshot used elsewhere by the full session view.
    expect(turns).toHaveLength(6)
    expect(shown[0]).toBe(turns[4])
})

test('T127 thread panel: Codex copied parent messages and later parent replies are hidden by fork time too', () => {
    const records = copiedAndNew.map((entry) => ({
        timestamp: entry.ts,
        type: 'response_item',
        payload: {
            type: 'message', role: entry.role,
            content: [{ type: entry.role === 'user' ? 'input_text' : 'output_text', text: entry.text }]
        }
    }))
    const turns = parseCodexTranscript(records.map((record) => JSON.stringify(record)).join('\n'))
    expect(turns.map(textOf)).toEqual(copiedAndNew.map((entry) => entry.text))
    expect(turnsAfterFork(turns, FORKED_AT).map(textOf)).toEqual(['Thread question', 'Thread answer'])
})

test('T127 thread panel: unknown or invalid timestamps stay hidden; no new turns yields the empty state', () => {
    const turn = (ts: string | null): ConversationTurn => ({ role: 'assistant', ts, parts: [{ kind: 'text', text: 'Unknown origin' }] })
    expect(turnsAfterFork([turn(null), turn(''), turn('not-a-time'), turn('2026-11-14T10:00:59.999Z')], FORKED_AT)).toEqual([])
    expect(turnsAfterFork([], FORKED_AT)).toEqual([])
    expect(turnsAfterFork([turn('2026-11-14T10:01:00.000Z')], Number.NaN)).toEqual([])
})

test('T127 thread panel: the fork boundary is inclusive and later timestamps preserve their source order', () => {
    const turns: ConversationTurn[] = [
        { role: 'user', ts: '2026-11-14T10:01:00.000Z', parts: [] },
        { role: 'assistant', ts: '2026-11-14T10:01:00.001Z', parts: [] }
    ]
    expect(turnsAfterFork(turns, FORKED_AT)).toEqual(turns)
    expect(turnsAfterFork(turns, FORKED_AT + 1)).toEqual([turns[1]])
})

test('T127 thread status: waiting takes priority over working, then idle regardless of list order', () => {
    const thread = (status: ChatThread['status']): ChatThread => ({
        childId: status, name: status, turnTs: null, forkedAt: FORKED_AT, status, lastActivityAt: FORKED_AT
    })
    expect(threadStatus([])).toBe('idle')
    expect(threadStatus([thread('idle')])).toBe('idle')
    expect(threadStatus([thread('idle'), thread('working')])).toBe('working')
    expect(threadStatus([thread('working'), thread('idle')])).toBe('working')
    expect(threadStatus([thread('working'), thread('waiting'), thread('idle')])).toBe('waiting')
    expect(threadStatus([thread('waiting'), thread('working')])).toBe('waiting')
})

test('T127 thread pagination: 400 child turns can load earlier replies until copied history is reached', () => {
    const copied: ConversationTurn[] = copiedAndNew.slice(0, 4).map((entry) => ({
        role: entry.role, ts: entry.ts, parts: [{ kind: 'text', text: entry.text }]
    }))
    const replies: ConversationTurn[] = Array.from({ length: 400 }, (_, index) => ({
        role: index % 2 === 0 ? 'user' : 'assistant',
        ts: new Date(FORKED_AT + index * 1000).toISOString(), parts: [{ kind: 'text', text: `Child turn ${index}` }]
    }))
    const all = [...copied, ...replies]
    const latest = snapshotOf(all.slice(-200), all.length)
    expect(hasEarlierThreadReplies(latest, FORKED_AT)).toBe(true)
    expect(turnsAfterFork(latest.turns, FORKED_AT)).toHaveLength(200)

    // All 400 child turns are loaded, but the parent prefix is not known until it enters a page.
    expect(hasEarlierThreadReplies(snapshotOf(all.slice(-400), all.length), FORKED_AT)).toBe(true)
    const reachedParent = snapshotOf(all.slice(-402), all.length)
    expect(hasEarlierThreadReplies(reachedParent, FORKED_AT)).toBe(false)
    expect(turnsAfterFork(reachedParent.turns, FORKED_AT)).toEqual(replies)
    expect(hasEarlierThreadReplies(snapshotOf(all), FORKED_AT)).toBe(false)
})

test('T127 thread pagination: missing and invalid timestamps cannot prove that earlier replies are copied', () => {
    const unknown: ConversationTurn[] = [null, '', 'invalid'].map((ts) => ({ role: 'assistant', ts, parts: [] }))
    expect(hasEarlierThreadReplies(snapshotOf(unknown, 400), FORKED_AT)).toBe(true)
    expect(hasEarlierThreadReplies(snapshotOf([], 400), FORKED_AT)).toBe(true)
    expect(hasEarlierThreadReplies(snapshotOf(unknown), FORKED_AT)).toBe(false)
})

test('T127 thread quote: global indexes select the correct reply with duplicate or null timestamps', () => {
    const timestamp = '2026-11-14T10:00:00.000Z'
    const turns: ConversationTurn[] = [
        { role: 'assistant', ts: timestamp, parts: [{ kind: 'text', text: 'First dated reply' }] },
        { role: 'user', ts: timestamp, parts: [{ kind: 'text', text: 'Same dated prompt' }] },
        { role: 'assistant', ts: timestamp, parts: [{ kind: 'text', text: 'Second dated reply' }] },
        { role: 'assistant', ts: null, parts: [{ kind: 'text', text: 'First undated reply' }] },
        { role: 'assistant', ts: null, parts: [{ kind: 'text', text: 'Second undated reply' }] }
    ]
    const snapshot = snapshotOf(turns, 15)
    expect(replyForThread(snapshot, { turnTs: timestamp, turnIndex: 12 })).toBe(turns[2])
    expect(replyForThread(snapshot, { turnTs: null, turnIndex: 13 })).toBe(turns[3])
    expect(replyForThread(snapshot, { turnTs: null, turnIndex: 14 })).toBe(turns[4])
    expect(replyForThread(snapshot, { turnTs: timestamp, turnIndex: 9 })).toBeUndefined()
    expect(replyForThread(snapshot, { turnTs: timestamp, turnIndex: 11 })).toBeUndefined()
    expect(replyForThread(snapshot, { turnTs: null, turnIndex: 12 })).toBeUndefined()
    expect(replyForThread(snapshot, { turnTs: timestamp, turnIndex: 15 })).toBeUndefined()
})

test('T127 thread quote: older unindexed anchors use the first matching assistant timestamp', () => {
    const timestamp = '2026-11-14T10:00:00.000Z'
    const turns: ConversationTurn[] = [
        { role: 'user', ts: timestamp, parts: [] },
        { role: 'assistant', ts: timestamp, parts: [] },
        { role: 'assistant', ts: null, parts: [] }
    ]
    const snapshot = snapshotOf(turns)
    expect(replyForThread(snapshot, { turnTs: timestamp })).toBe(turns[1])
    expect(replyForThread(snapshot, { turnTs: null })).toBe(turns[2])
    expect(replyForThread(snapshot, { turnTs: 'missing' })).toBeUndefined()
})

test('T127 readable quote: a table-first answer quotes the first prose paragraph without table source', () => {
    const answer = '| file | change |\n| --- | --- |\n| index.tsx | Fixed |\n\nThe thread stays beside its parent.\nYou can keep writing here.\n\nA later paragraph.'
    expect(threadQuote(answer)).toBe('The thread stays beside its parent.\nYou can keep writing here.')
    expect(threadQuote(answer)).not.toContain('|')
    expect(threadQuote('| file | change |\n| --- | --- |')).toBe('')
})

test('T127 readable quote: code-only answers get a short label; code and its blank lines are skipped', () => {
    expect(threadQuote('```ts\nconst hidden = true\n\nconsole.log(hidden)\n```')).toBe('(code)')
    expect(threadQuote('~~~~js\n```not a closing fence\n~~~~\n\nA readable explanation.')).toBe('A readable explanation.')
    expect(threadQuote('```ts\nUnfinished fenced code')).toBe('(code)')
    expect(threadQuote('')).toBe('')
})

test('T127 readable quote: headings, list markers, links, emphasis and inline code become plain text', () => {
    expect(threadQuote('## **Thread replies** ##\n- Read the [guide](https://example.com/path_(thread)) and `code`.\n2. _Keep_ *writing* ~~here~~.')).toBe('Thread replies\nRead the guide and code.\nKeep writing here.')
    expect(threadQuote('- [x] **Done**\r\n\r\nNext paragraph')).toBe('Done')
    expect(threadQuote('Use `thread_id` in the [API](https://example.com).')).toBe('Use thread_id in the API.')
    expect(threadQuote('Keep `__init__` and `a ** b` intact.')).toBe('Keep __init__ and a ** b intact.')
})

test('T127 readable quote: long paragraphs stay within three lines and 240 characters with an ellipsis', () => {
    const long = threadQuote('A'.repeat(300))
    expect(long).toBe(`${'A'.repeat(239)}…`)
    expect(long.length).toBe(240)
    const lines = threadQuote('First\nSecond\nThird\nFourth\n\nNext paragraph')
    expect(lines).toBe('First\nSecond\nThird…')
    expect(lines.split('\n')).toHaveLength(3)
    expect(threadQuote('A'.repeat(240))).toBe('A'.repeat(240))
    const emoji = threadQuote(`${'A'.repeat(238)}😀${'B'.repeat(10)}`)
    expect(emoji).toBe(`${'A'.repeat(238)}…`)
})
