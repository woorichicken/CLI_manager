import { test, expect } from '@playwright/test'
import { chatThreadParentIds, chatThreadSnapshot, chatThreadsFor, pollChatThreadChanges } from '../../src/main/chatThreads'
import type { SessionRelation } from '../../src/shared/types'

const TS = '2026-11-14T10:00:00.000Z'
const sessions = ['parent', 'one', 'two', 'three'].map((id) => ({ id, name: `Session ${id}` }))
const fork = (to: string, extra: Partial<SessionRelation> = {}): SessionRelation => ({
    from: 'parent', to, kind: 'opened', at: 100, anchor: { turnTs: TS, turnIndex: 0 }, ...extra
})
const screen = {
    hasExited: (_id: string) => false,
    screenStatus: (_id: string): { busy: boolean; question: string | null } => ({ busy: false, question: null }),
    lastOutputAt: (_id: string) => 0
}

test('T127: only live outward forks with anchors belong to a reply; old and dismissed Related pairs do not', () => {
    const relations = [
        fork('one'),
        fork('two', { anchor: undefined }),
        fork('three', { dismissed: true }),
        fork('missing'),
        fork('two', { from: 'two', to: 'parent' }),
        fork('two', { kind: 'connected' }),
        fork('two', { kind: 'manual' })
    ]
    expect(chatThreadsFor('parent', relations, sessions, screen)).toEqual([{
        childId: 'one', name: 'Session one', turnTs: TS, turnIndex: 0, status: 'idle', lastActivityAt: 100
    }])
    expect(chatThreadsFor('missing-parent', relations, sessions, screen)).toEqual([])
})

test('T127: working, question and idle come from the existing screen status; an exited child is idle', () => {
    const reads: string[] = []
    const rows = chatThreadsFor('parent', [fork('one'), fork('two'), fork('three')], sessions, {
        ...screen,
        hasExited: (id) => id === 'three',
        screenStatus: (id) => {
            reads.push(id)
            return id === 'one' ? { busy: true, question: null } : { busy: false, question: 'Allow this?' }
        }
    })
    expect(rows.map((row) => [row.childId, row.status])).toEqual([['one', 'working'], ['three', 'idle'], ['two', 'waiting']])
    expect(reads).toEqual(['one', 'two'])
})

test('T127: last child output supplies activity and sorting; a quiet new fork uses its opened time', () => {
    const rows = chatThreadsFor('parent', [fork('one'), fork('two', { at: 300 }), fork('three', { anchor: { turnTs: TS } })], sessions, {
        ...screen,
        lastOutputAt: (id) => id === 'one' ? 500 : id === 'three' ? 200 : 0
    })
    expect(rows.map((row) => [row.childId, row.lastActivityAt])).toEqual([['one', 500], ['two', 300], ['three', 200]])
    expect(rows[2]).not.toHaveProperty('turnIndex')
})

test('T127: renamed children are read afresh and closing either side removes the rows', () => {
    const relations = [fork('one')]
    expect(chatThreadsFor('parent', relations, sessions.map((session) => session.id === 'one' ? { ...session, name: 'New name' } : session), screen)[0].name).toBe('New name')
    expect(chatThreadsFor('parent', relations, sessions.filter((session) => session.id !== 'one'), screen)).toEqual([])
    expect(chatThreadsFor('parent', relations, sessions.filter((session) => session.id !== 'parent'), screen)).toEqual([])
    expect(chatThreadsFor('parent', [], sessions, screen)).toEqual([])
})

test('T127 polling: several subscribed parents share one read of each store value per tick', () => {
    const reads = { relations: 0, sessions: 0 }
    const data = { relations: [fork('one'), fork('two', { from: 'three' })], sessions }
    const store = {
        get<K extends keyof typeof data>(key: K): typeof data[K] {
            reads[key]++
            return data[key]
        }
    }
    const tick = pollChatThreadChanges(new Set(['parent', 'three', 'two']), chatThreadParentIds(data.relations), new Map(), {
        relations: () => store.get('relations'),
        sessions: () => store.get('sessions'),
        screen
    })
    expect(reads).toEqual({ relations: 1, sessions: 1 })
    expect(tick.changed).toEqual(['parent', 'three', 'two'])
    expect(tick.snapshots.get('parent')).toContain('one')
    expect(tick.snapshots.get('three')).toContain('two')
})

test('T127 polling: chats without anchored children read the store zero times, including after removal', () => {
    let reads = 0
    const sources = {
        relations: (): SessionRelation[] => { reads++; return [] },
        sessions: () => { reads++; return sessions },
        screen
    }
    const active = chatThreadParentIds([fork('one')])
    // Another parent's fork must not cause I/O for the parents currently being watched.
    const empty = pollChatThreadChanges(new Set(['two', 'three']), active, new Map(), sources)
    expect(reads).toBe(0)
    expect(pollChatThreadChanges(new Set(['two']), active, empty.snapshots, sources).changed).toEqual([])
    expect(reads).toBe(0)

    const previous = new Map([['parent', chatThreadSnapshot(chatThreadsFor('parent', [fork('one')], sessions, screen))]])
    const removed = chatThreadParentIds([fork('one', { dismissed: true }), fork('two', { anchor: undefined }), fork('three', { kind: 'manual' })])
    const closed = pollChatThreadChanges(new Set(['parent']), removed, previous, sources)
    expect(removed.size).toBe(0)
    expect(closed.changed).toEqual(['parent'])
    expect(closed.snapshots.get('parent')).toBe('[]')
    expect(reads).toBe(0)
    expect(pollChatThreadChanges(new Set(), active, previous, sources).snapshots.size).toBe(0)
    expect(reads).toBe(0)
})

test('T127 polling: output within a 30s activity bucket is quiet, while state, names and counts notify immediately', () => {
    let at = 1000
    let status = { busy: false, question: null as string | null }
    let name = 'Session one'
    let relations = [fork('one')]
    const sources = {
        relations: () => relations,
        sessions: () => sessions.map((session) => session.id === 'one' ? { ...session, name } : session),
        screen: { ...screen, lastOutputAt: () => at, screenStatus: () => status }
    }
    let previous = new Map<string, string>()
    const tick = (): string[] => {
        const result = pollChatThreadChanges(new Set(['parent']), chatThreadParentIds(relations), previous, sources)
        previous = result.snapshots
        return result.changed
    }
    expect(tick()).toEqual(['parent'])
    at = 29_999
    expect(tick()).toEqual([])
    status = { busy: true, question: null }
    expect(tick()).toEqual(['parent'])
    status = { busy: false, question: 'Allow this?' }
    expect(tick()).toEqual(['parent'])
    name = 'Renamed thread'
    expect(tick()).toEqual(['parent'])
    relations = [...relations, fork('two')]
    expect(tick()).toEqual(['parent'])
    at = 30_000
    expect(tick()).toEqual(['parent'])
    expect(tick()).toEqual([])
    // The IPC response keeps the precise output time; only notification comparison is bucketed.
    expect(chatThreadsFor('parent', relations, sources.sessions(), sources.screen)[0].lastActivityAt).toBe(at)
})

test('T127 polling: children trading most recent output within one bucket does not notify by reordering', () => {
    const relations = [fork('one'), fork('two')]
    const before = chatThreadsFor('parent', relations, sessions, { ...screen, lastOutputAt: (id) => id === 'one' ? 2000 : 1000 })
    const after = chatThreadsFor('parent', relations, sessions, { ...screen, lastOutputAt: (id) => id === 'one' ? 2000 : 3000 })
    expect(before.map((thread) => thread.childId)).not.toEqual(after.map((thread) => thread.childId))
    expect(chatThreadSnapshot(after)).toBe(chatThreadSnapshot(before))
})
