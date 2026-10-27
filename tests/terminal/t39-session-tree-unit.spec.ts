import { test, expect } from '@playwright/test'
import { MAX_TREE_DEPTH, sessionTreeFor, sessionForestFor } from '../../src/renderer/src/utils/relatedSessions'
import { RecentSessions, RECENT_SESSIONS_KEY, RECENT_SESSIONS_MAX } from '../../src/main/RecentSessions'
import type { RelationStore } from '../../src/main/SessionRelations'
import type { SessionRelation, TerminalSession, Workspace } from '../../src/shared/types'

/**
 * T39 — Session tree (the Related dialog's relation tab), pure logic (no Electron).
 *
 * `sessionTreeFor` folds the same relations T34 groups into one tree around a
 * session: who opened it (above, several levels), who shares its parent
 * (beside) and what it opened (below, grandchildren too).
 */

function session(id: string): TerminalSession {
    return { id, name: id, cwd: '/tmp', type: 'regular' }
}

function workspaces(ids: string[]): Workspace[] {
    return [{ id: 'ws', name: 'ws', path: '/tmp', sessions: ids.map(session), createdAt: 0 } as Workspace]
}

function rel(from: string, to: string, kind: SessionRelation['kind'] = 'opened', at = 100): SessionRelation {
    return { from, to, kind, at }
}

const ids = (entries: Array<{ session: { id: string } }>): string[] => entries.map(e => e.session.id)

test.describe('T39 session tree', () => {
    test('T39 tree: siblings come from the shared parent', () => {
        // Tonight's shape: chief -> leads A, B, C -> A opened two workers.
        const relations = [
            rel('chief', 'A', 'opened', 1), rel('chief', 'B', 'opened', 2), rel('chief', 'C', 'opened', 3),
            rel('A', 'w1', 'opened', 4), rel('A', 'w2', 'opened', 5)
        ]
        const tree = sessionTreeFor(relations, 'A', workspaces(['chief', 'A', 'B', 'C', 'w1', 'w2']))
        expect(ids(tree.ancestors)).toEqual(['chief'])
        expect(ids(tree.siblings).sort()).toEqual(['B', 'C'])
        expect(ids(tree.descendants).sort()).toEqual(['w1', 'w2'])
        expect(tree.descendants.every(e => e.depth === 1)).toBe(true)
    })

    test('T39 tree: a cycle of connected relations ends', () => {
        const relations = [rel('A', 'B', 'connected'), rel('B', 'C', 'connected'), rel('C', 'A', 'connected')]
        const tree = sessionTreeFor(relations, 'A', workspaces(['A', 'B', 'C']))
        const all = [...ids(tree.ancestors), ...ids(tree.siblings), ...ids(tree.descendants)]
        // Every other session shows once, and the walk comes back at all.
        expect(all.sort()).toEqual(['B', 'C'])
    })

    test('T39 tree: dismissed pairs and manual pairs stay out of the tree', () => {
        const relations: SessionRelation[] = [
            rel('A', 'gone', 'opened'), { ...rel('A', 'hidden', 'opened'), dismissed: true },
            rel('A', 'hand', 'manual')
        ]
        const tree = sessionTreeFor(relations, 'A', workspaces(['A', 'gone', 'hidden', 'hand']))
        expect(ids(tree.descendants)).toEqual(['gone'])
        expect(ids(tree.manual)).toEqual(['hand'])
        expect(tree.ancestors).toEqual([])
        expect(tree.siblings).toEqual([])
    })

    test('T39 tree: two parents show both above, siblings are not repeated', () => {
        const relations = [
            rel('P', 'S', 'opened'), rel('Q', 'S', 'connected'),
            rel('P', 'X'), rel('Q', 'X', 'connected'), rel('Q', 'Y')
        ]
        const tree = sessionTreeFor(relations, 'S', workspaces(['P', 'Q', 'S', 'X', 'Y']))
        expect(ids(tree.ancestors).sort()).toEqual(['P', 'Q'])
        expect(ids(tree.siblings).sort()).toEqual(['X', 'Y'])
    })

    test('T39 tree: a closed middle session cuts what hangs under it', () => {
        const relations = [rel('A', 'M'), rel('M', 'leaf')]
        const tree = sessionTreeFor(relations, 'A', workspaces(['A', 'leaf']))
        expect(tree.descendants).toEqual([])
    })

    test('T39 tree: depth is numbered and capped', () => {
        const chain = Array.from({ length: MAX_TREE_DEPTH + 3 }, (_, i) => `n${i}`)
        const relations = chain.slice(1).map((id, i) => rel(chain[i], id))
        const tree = sessionTreeFor(relations, 'n0', workspaces(chain))
        expect(tree.descendants.map(e => e.depth)).toEqual(Array.from({ length: MAX_TREE_DEPTH }, (_, i) => i + 1))
    })
})

class MemoryStore implements RelationStore {
    readonly data: Record<string, unknown> = {}
    writes = 0
    get(key: string): unknown {
        return this.data[key]
    }
    set(key: string, value: unknown): void {
        this.writes++
        // A deep copy, as a JSON file would hold it.
        this.data[key] = JSON.parse(JSON.stringify(value))
    }
}

test.describe('T39 tree order (49825c14)', () => {
    // A opened w1..w3 in that order and w2 opened its own helper; chief opened A and B.
    const relations = [
        rel('chief', 'A', 'opened', 1), rel('chief', 'B', 'opened', 2),
        rel('A', 'w1', 'opened', 3), rel('A', 'w2', 'opened', 4), rel('A', 'w3', 'opened', 5),
        rel('w2', 'helper', 'opened', 6)
    ]
    const all = workspaces(['chief', 'A', 'B', 'w1', 'w2', 'w3', 'helper'])

    test('T39 order: recently viewed first, never viewed after them newest first; children stay under their parent', () => {
        // Viewed w3 last, then w1; w2 never — and B (a sibling) was viewed, the chief was not.
        const tree = sessionTreeFor(relations, 'A', all, 'viewed', ['w1', 'B', 'w3'])
        expect(ids(tree.descendants)).toEqual(['w1', 'w3', 'w2', 'helper'])
        expect(tree.descendants.find(e => e.session.id === 'helper')?.depth).toBe(2)
        expect(ids(tree.siblings)).toEqual(['B'])
    })

    test('T39 order: oldest first and by name keep the same tree', () => {
        expect(ids(sessionTreeFor(relations, 'A', all, 'oldest').descendants)).toEqual(['w1', 'w2', 'helper', 'w3'])
        expect(ids(sessionTreeFor(relations, 'A', all, 'name').descendants)).toEqual(['w1', 'w2', 'helper', 'w3'])
        expect(ids(sessionTreeFor(relations, 'A', all).descendants)).toEqual(['w3', 'w2', 'helper', 'w1'])
    })
})

test.describe('T39 recent sessions', () => {
    test('T39 recent: capped, repeat moves to front, survives a restart, prune drops gone ones', () => {
        const store = new MemoryStore()
        const recent = new RecentSessions(store)
        for (let i = 0; i < RECENT_SESSIONS_MAX + 1; i++) recent.push(`s${i}`)
        expect(recent.list()).toHaveLength(RECENT_SESSIONS_MAX)
        // Newest first; the oldest one fell off.
        expect(recent.list()[0]).toBe(`s${RECENT_SESSIONS_MAX}`)
        expect(recent.list()).not.toContain('s0')

        recent.push('s5')
        expect(recent.list()[0]).toBe('s5')
        expect(recent.list().filter(id => id === 's5')).toHaveLength(1)

        // A new instance on the same store is a restart.
        const afterRestart = new RecentSessions(store)
        expect(afterRestart.list()).toEqual(recent.list())

        afterRestart.prune(new Set(['s5', 's7']))
        expect(afterRestart.list()).toEqual(['s5', 's7'])
        expect(new RecentSessions(store).list()).toEqual(['s5', 's7'])
    })

    test('T39 recent: pushing the id already in front writes nothing', () => {
        const store = new MemoryStore()
        const recent = new RecentSessions(store)
        recent.push('a')
        const writes = store.writes
        recent.push('a')
        expect(store.writes).toBe(writes)
        expect(store.data[RECENT_SESSIONS_KEY]).toEqual(['a'])
    })

    test('T39 recent: a closed session is dropped on forget', () => {
        const recent = new RecentSessions(new MemoryStore())
        recent.push('a')
        recent.push('b')
        recent.forget('a')
        expect(recent.list()).toEqual(['b'])
    })
})

/** The listed sessions of `workspaces(ids)`, in list order — what the sidebar hands the forest. */
function entries(list: string[]): Array<{ session: TerminalSession; workspace: Workspace }> {
    const [ws] = workspaces(list)
    return ws.sessions.map(s => ({ session: s, workspace: ws }))
}

const forestRows = (forest: ReturnType<typeof sessionForestFor>) => forest.rows.map(r => `${r.session.id}@${r.depth}`)

// The All sessions Tree layout (day-1027): one tree per root, built by sessionTreeFor.
test.describe('T39 session forest', () => {
    test('T39 forest: roots in list order, children under their parent, the rest unlinked', () => {
        const relations = [
            rel('chief', 'A', 'opened', 1), rel('chief', 'B', 'opened', 2), rel('A', 'w', 'opened', 3),
            rel('solo', 'x', 'manual', 4), rel('B', 'gone', 'opened', 5), { ...rel('B', 'y', 'opened', 6), dismissed: true }
        ]
        // 'gone' is not listed (a hidden worktree's session): the relation to it draws nothing.
        const forest = sessionForestFor(relations, entries(['y', 'x', 'w', 'solo', 'chief', 'B', 'A']))
        expect(forestRows(forest)).toEqual(['chief@0', 'B@1', 'A@1', 'w@2'])
        // Hand-added and removed pairs have no place in a tree; list order is kept.
        expect(ids(forest.unlinked)).toEqual(['y', 'x', 'solo'])
    })

    test('T39 forest: a ring shows each session once, rooted at the first in the list', () => {
        const relations = [rel('A', 'B', 'connected', 1), rel('B', 'C', 'connected', 2), rel('C', 'A', 'connected', 3)]
        const forest = sessionForestFor(relations, entries(['B', 'A', 'C']))
        expect(forestRows(forest)).toEqual(['B@0', 'C@1', 'A@2'])
        expect(forest.unlinked).toEqual([])
    })

    test('T39 forest: a session with two parents shows once, with what hangs under it', () => {
        const relations = [rel('P1', 'X', 'opened', 1), rel('P2', 'X', 'connected', 2), rel('X', 'Y', 'opened', 3)]
        const forest = sessionForestFor(relations, entries(['P2', 'P1', 'X', 'Y']))
        // P2 is first in the list, so X and Y go under it; P1 is left a root of nothing.
        expect(forestRows(forest)).toEqual(['P2@0', 'X@1', 'Y@2', 'P1@0'])
    })

    test('T39 forest: a chain past the depth limit continues as a tree of its own', () => {
        const chain = Array.from({ length: MAX_TREE_DEPTH + 3 }, (_, i) => `n${i}`)
        const relations = chain.slice(1).map((id, i) => rel(chain[i], id, 'opened', i))
        const forest = sessionForestFor(relations, entries(chain))
        const rows = forestRows(forest)
        expect(rows.slice(0, MAX_TREE_DEPTH + 1)).toEqual(chain.slice(0, MAX_TREE_DEPTH + 1).map((id, depth) => `${id}@${depth}`))
        expect(rows[MAX_TREE_DEPTH + 1]).toBe(`n${MAX_TREE_DEPTH + 1}@0`)
        expect(new Set(forest.rows.map(r => r.session.id)).size).toBe(chain.length)
    })

    test('T39 forest: each level follows the viewed order, like the list', () => {
        const relations = [rel('root', 'old', 'opened', 1), rel('root', 'new', 'opened', 2)]
        expect(forestRows(sessionForestFor(relations, entries(['root', 'old', 'new'])))).toEqual(['root@0', 'new@1', 'old@1'])
        expect(forestRows(sessionForestFor(relations, entries(['root', 'old', 'new']), ['old']))).toEqual(['root@0', 'old@1', 'new@1'])
    })
})
