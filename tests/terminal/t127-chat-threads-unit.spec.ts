import { test, expect } from '@playwright/test'
import { chatThreadsFor } from '../../src/main/chatThreads'
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
