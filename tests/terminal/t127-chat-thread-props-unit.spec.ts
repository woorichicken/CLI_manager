import { test, expect } from '@playwright/test'
import type { ChatThread } from '../../src/shared/conversation'
import { groupThreadsByTurn, threadsForTurn } from '../../src/renderer/src/components/ChatView/threadGroups'

const TS = '2026-11-14T10:00:00.000Z'
const OTHER_TS = '2026-11-14T11:00:00.000Z'
const thread = (childId: string, extra: Partial<ChatThread> = {}): ChatThread => ({
    childId, name: `Session ${childId}`, turnTs: TS, turnIndex: 4, status: 'idle', lastActivityAt: 100, ...extra
})

test('T127 props: answers without threads keep the same undefined prop across thread and snapshot changes', () => {
    const empty = groupThreadsByTurn([])
    const before = threadsForTurn(empty, TS, 4)
    const added = groupThreadsByTurn([thread('other', { turnTs: OTHER_TS })], empty)
    expect(threadsForTurn(added, TS, 4)).toBe(before)
    expect(before).toBeUndefined()

    // Streaming and pagination change the displayed turn objects, but lookup uses their global place.
    const snapshots = [
        { totalTurns: 5, turns: [{ ts: OTHER_TS }, { ts: TS }] },
        { totalTurns: 6, turns: [{ ts: TS }, { ts: OTHER_TS }] }
    ]
    const props = snapshots.map((snapshot) => {
        const index = snapshot.turns.findIndex((turn) => turn.ts === TS)
        return threadsForTurn(added, snapshot.turns[index].ts, snapshot.totalTurns - snapshot.turns.length + index)
    })
    expect(props[0]).toBe(before)
    expect(props[1]).toBe(before)
})

test('T127 props: unchanged rows retain their array through new IPC objects and changes on another answer', () => {
    const rows = [thread('one'), thread('other', { turnTs: OTHER_TS })]
    const first = groupThreadsByTurn(rows)
    const answer = threadsForTurn(first, TS, 4)
    expect(threadsForTurn(first, TS, 4)).toBe(answer)
    const equal = groupThreadsByTurn(rows.map((row) => ({ ...row })), first)
    expect(threadsForTurn(equal, TS, 4)).toBe(answer)

    const changed = groupThreadsByTurn([thread('one'), thread('other', { turnTs: OTHER_TS, status: 'working' })], equal)
    expect(threadsForTurn(changed, TS, 4)).toBe(answer)
    expect(threadsForTurn(changed, OTHER_TS, 4)).not.toBe(threadsForTurn(equal, OTHER_TS, 4))
    expect(threadsForTurn(changed, OTHER_TS, 4)?.[0].status).toBe('working')
    const removed = groupThreadsByTurn([thread('one')], changed)
    expect(threadsForTurn(removed, TS, 4)).toBe(answer)
    expect(threadsForTurn(removed, OTHER_TS, 4)).toBeUndefined()
})

test('T127 props: indexed anchors match the global index and unindexed anchors keep timestamp compatibility and order', () => {
    const rows = [thread('four'), thread('legacy', { turnIndex: undefined }), thread('five', { turnIndex: 5 })]
    const groups = groupThreadsByTurn(rows)
    expect(threadsForTurn(groups, TS, 4)?.map((row) => row.childId)).toEqual(['four', 'legacy'])
    expect(threadsForTurn(groups, TS, 5)?.map((row) => row.childId)).toEqual(['legacy', 'five'])
    expect(threadsForTurn(groups, TS, 0)?.map((row) => row.childId)).toEqual(['legacy'])
    expect(threadsForTurn(groups, OTHER_TS, 4)).toBeUndefined()
})

test('T127 props: null timestamps remain distinct from empty or string timestamps', () => {
    const groups = groupThreadsByTurn([
        thread('null-indexed', { turnTs: null }),
        thread('null-legacy', { turnTs: null, turnIndex: undefined }),
        thread('empty', { turnTs: '' }),
        thread('dated')
    ])
    expect(threadsForTurn(groups, null, 4)?.map((row) => row.childId)).toEqual(['null-indexed', 'null-legacy'])
    expect(threadsForTurn(groups, null, 8)?.map((row) => row.childId)).toEqual(['null-legacy'])
    expect(threadsForTurn(groups, '', 4)?.map((row) => row.childId)).toEqual(['empty'])
    expect(threadsForTurn(groups, TS, 4)?.map((row) => row.childId)).toEqual(['dated'])
})
