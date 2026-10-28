import { test, expect } from '@playwright/test'
import { MAX_TREE_DEPTH, sessionTreeFor, sessionForestFor, splitTreeRelations, wouldMakeLoop, handParentsInTheWay, treeGuidesFor } from '../../src/renderer/src/utils/relatedSessions'
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

    test('T39 tree: dismissed pairs stay out; a hand-added pair hangs under the session it was dropped on', () => {
        // Stored as SessionRelations.add(dropped on, dragged) writes it: from = parent.
        const relations: SessionRelation[] = [
            rel('A', 'gone', 'opened', 1), { ...rel('A', 'hidden', 'opened', 2), dismissed: true },
            rel('A', 'hand', 'manual', 3)
        ]
        const tree = sessionTreeFor(relations, 'A', workspaces(['A', 'gone', 'hidden', 'hand']), 'oldest')
        expect(ids(tree.descendants)).toEqual(['gone', 'hand'])
        expect(tree.descendants.find(e => e.session.id === 'hand')?.kind).toBe('manual')
        expect(tree.other).toEqual([])
        expect(tree.ancestors).toEqual([])
        expect(tree.siblings).toEqual([])
        // From the dragged session's side the drop target is its parent.
        expect(ids(sessionTreeFor(relations, 'hand', workspaces(['A', 'gone', 'hand'])).ancestors)).toEqual(['A'])
    })

    test('T39 tree: two parents — the hand-added one wins, the opener is kept under Also related (9fa825e7)', () => {
        // P opened S; the user then dragged S onto H.
        const relations = [rel('P', 'S', 'opened', 1), rel('P', 'X', 'opened', 2), rel('H', 'S', 'manual', 3), rel('H', 'Y', 'opened', 4)]
        const all = workspaces(['P', 'H', 'S', 'X', 'Y'])
        const tree = sessionTreeFor(relations, 'S', all)
        expect(ids(tree.ancestors)).toEqual(['H'])
        // Siblings follow the winning parent only.
        expect(ids(tree.siblings)).toEqual(['Y'])
        expect(ids(tree.other)).toEqual(['P'])
        // The opener's dialog no longer has S below it, but still lists it.
        const opener = sessionTreeFor(relations, 'P', all)
        expect(ids(opener.descendants)).toEqual(['X'])
        expect(ids(opener.other)).toEqual(['S'])
        expect(ids(sessionTreeFor(relations, 'H', all, 'oldest').descendants)).toEqual(['S', 'Y'])
    })

    test('T39 tree: dragged twice, the newest drop is its place; a removed drop gives the place back', () => {
        const relations: SessionRelation[] = [rel('P', 'S', 'opened', 1), rel('H1', 'S', 'manual', 2), rel('H2', 'S', 'manual', 3)]
        const all = workspaces(['P', 'H1', 'H2', 'S'])
        expect(ids(sessionTreeFor(relations, 'S', all).ancestors)).toEqual(['H2'])
        expect(ids(sessionTreeFor(relations, 'S', all, 'oldest').other)).toEqual(['P', 'H1'])
        const removed = relations.map(r => r.from === 'H2' ? { ...r, dismissed: true } : r)
        expect(ids(sessionTreeFor(removed, 'S', all).ancestors)).toEqual(['H1'])
        // A closed drop target does not hold the place either: back to the opener.
        expect(ids(sessionTreeFor(relations.filter(r => r.kind !== 'manual'), 'S', workspaces(['P', 'S'])).ancestors)).toEqual(['P'])
        expect(ids(sessionTreeFor(relations, 'S', workspaces(['P', 'S'])).ancestors)).toEqual(['P'])
    })

    test('T39 tree: splitTreeRelations keeps the winning pair and sets the others aside', () => {
        const relations: SessionRelation[] = [
            rel('P', 'S', 'opened', 1), rel('H', 'S', 'manual', 2), rel('S', 'K', 'opened', 3),
            { ...rel('Z', 'S', 'manual', 9), dismissed: true }, rel('gone', 'S', 'manual', 10)
        ]
        const split = splitTreeRelations(relations, id => id !== 'gone')
        expect(split.tree.map(r => `${r.from}>${r.to}`)).toEqual(['H>S', 'S>K'])
        expect(split.aside.map(r => `${r.from}>${r.to}`)).toEqual(['P>S'])
    })

    test('T39 loop: a session cannot go under itself or under anything below it', () => {
        // chief -> lead -> worker, and helper hung under worker by hand.
        const relations = [rel('chief', 'lead', 'opened', 1), rel('lead', 'worker', 'opened', 2), rel('worker', 'helper', 'manual', 3)]
        const all = workspaces(['chief', 'lead', 'worker', 'helper', 'loose'])
        expect(wouldMakeLoop(relations, 'worker', 'chief', all)).toBe(true)
        expect(wouldMakeLoop(relations, 'helper', 'lead', all)).toBe(true)
        expect(wouldMakeLoop(relations, 'lead', 'lead', all)).toBe(true)
        // Down or sideways is fine, and so is moving a child to another branch.
        expect(wouldMakeLoop(relations, 'chief', 'helper', all)).toBe(false)
        expect(wouldMakeLoop(relations, 'loose', 'lead', all)).toBe(false)
        expect(wouldMakeLoop(relations, 'helper', 'loose', all)).toBe(false)
        // A pair that lost its place does not count: P opened S, S was dragged onto H, so P is not above S.
        const moved = [rel('P', 'S', 'opened', 1), rel('H', 'S', 'manual', 2)]
        expect(wouldMakeLoop(moved, 'S', 'P', workspaces(['P', 'H', 'S']))).toBe(false)
        expect(wouldMakeLoop(moved, 'S', 'H', workspaces(['P', 'H', 'S']))).toBe(true)
    })

    test('T39 drop back: the hand-added pairs keeping a session from a parent it already has are the ones in the way', () => {
        // P opened S; S was dragged onto H1, then onto H2. Dropping it back on P: both drops are in the way.
        const relations: SessionRelation[] = [rel('P', 'S', 'opened', 1), rel('H1', 'S', 'manual', 2), rel('H2', 'S', 'manual', 3), rel('P', 'K', 'opened', 4)]
        const all = workspaces(['P', 'H1', 'H2', 'S', 'K'])
        expect(handParentsInTheWay(relations, 'P', 'S', all).map(r => r.from)).toEqual(['H1', 'H2'])
        // Back on H1 (itself a drop): only the newer drop is in the way.
        expect(handParentsInTheWay(relations, 'H1', 'S', all).map(r => r.from)).toEqual(['H2'])
        // Already where it is shown, a pair not stored yet, or reversed: nothing to remove.
        expect(handParentsInTheWay(relations, 'H2', 'S', all)).toEqual([])
        expect(handParentsInTheWay(relations, 'K', 'S', all)).toEqual([])
        expect(handParentsInTheWay(relations, 'S', 'P', all)).toEqual([])
        // With those removed, the tree puts S back under P.
        const removed = relations.map(r => r.to === 'S' && r.kind === 'manual' ? { ...r, dismissed: true } : r)
        expect(ids(sessionTreeFor(removed, 'S', all).ancestors)).toEqual(['P'])
    })

    test('T39 tree: an old hand-added loop (stored before drops were checked) still shows each session once', () => {
        const relations = [rel('A', 'B', 'opened', 1), rel('B', 'C', 'opened', 2), rel('C', 'A', 'manual', 3)]
        const tree = sessionTreeFor(relations, 'A', workspaces(['A', 'B', 'C']))
        const all = [...ids(tree.ancestors), ...ids(tree.siblings), ...ids(tree.descendants), ...ids(tree.other)]
        expect(all.sort()).toEqual(['B', 'C'])
        const forest = sessionForestFor(relations, entries(['A', 'B', 'C']))
        expect(new Set(forest.rows.map(r => r.session.id)).size).toBe(3)
        expect(forest.unlinked).toEqual([])
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
    test('T39 forest: roots in list order, children oldest first under their parent, the rest unlinked', () => {
        const relations = [
            rel('chief', 'A', 'opened', 1), rel('chief', 'B', 'opened', 2), rel('A', 'w', 'opened', 3),
            rel('solo', 'x', 'manual', 4), rel('B', 'gone', 'opened', 5), { ...rel('B', 'y', 'opened', 6), dismissed: true }
        ]
        // 'gone' is not listed (a hidden worktree's session): the relation to it draws nothing.
        const forest = sessionForestFor(relations, entries(['y', 'x', 'w', 'solo', 'chief', 'B', 'A']))
        // x was dragged onto solo: solo is its parent. A removed pair has no place; list order is kept.
        expect(forestRows(forest)).toEqual(['solo@0', 'x@1', 'chief@0', 'A@1', 'w@2', 'B@1'])
        expect(ids(forest.unlinked)).toEqual(['y'])
    })

    test('T39 forest: a session dragged onto another moves there, out from under its opener', () => {
        const relations = [rel('chief', 'lead', 'opened', 1), rel('lead', 'w1', 'opened', 2), rel('lead', 'w2', 'opened', 3), rel('other', 'w1', 'manual', 4)]
        const forest = sessionForestFor(relations, entries(['chief', 'lead', 'w1', 'w2', 'other']))
        expect(forestRows(forest)).toEqual(['chief@0', 'lead@1', 'w2@2', 'other@0', 'w1@1'])
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

    test('T39 forest: the order is fixed — oldest relation first, roots in the order given (d44191ed)', () => {
        const relations = [rel('root', 'old', 'opened', 1), rel('root', 'new', 'opened', 2), rel('root2', 'kid', 'opened', 3)]
        // However the list is shuffled by viewing, the sidebar hands the tree the same sidebar order.
        expect(forestRows(sessionForestFor(relations, entries(['root', 'old', 'new', 'root2', 'kid']))))
            .toEqual(['root@0', 'old@1', 'new@1', 'root2@0', 'kid@1'])
        expect(forestRows(sessionForestFor(relations, entries(['root2', 'new', 'kid', 'root', 'old']))))
            .toEqual(['root2@0', 'kid@1', 'root@0', 'old@1', 'new@1'])
    })
})

// The Tree's guide lines (a35f1aa1): ├ │ └ worked out from the depths of the rows on screen.
test.describe('T39 tree guides', () => {
    // One string per row: connector (├ / └ / · for a root), the levels whose line runs past it, ↓ when a child follows.
    const drawn = (depths: number[]): string[] => treeGuidesFor(depths).map((guide, i) =>
        `${depths[i] === 0 ? '·' : guide.continues ? '├' : '└'}${guide.through.length ? `|${guide.through.join(',')}` : ''}${guide.opensDown ? '↓' : ''}`)

    test('T39 guides: siblings join with ├ and the last one ends with └; an ancestor\'s line runs past deeper rows', () => {
        // chief > lead > (worker > loose), w2 · lead B · root2 > x
        expect(drawn([0, 1, 2, 3, 2, 1, 0, 1])).toEqual(['·↓', '├↓', '├|1↓', '└|1,2', '└|1', '└', '·↓', '└'])
    })

    test('T39 guides: a line stops where its level ends, and another root starts fresh', () => {
        // The lead's line does not run on into the next tree: nothing at depth 1 follows before the next root.
        expect(drawn([0, 1, 2, 2, 0, 1, 1])).toEqual(['·↓', '└↓', '├', '└', '·↓', '├', '└'])
        expect(drawn([0, 1, 2, 1])).toEqual(['·↓', '├↓', '└|1', '└'])
    })

    test('T39 guides: a folded row has nothing shown under it, so no line runs down from it', () => {
        // The worker folded: its child is gone from the rows, and it reads as a plain sibling.
        expect(drawn([0, 1, 2, 2, 1])).toEqual(['·↓', '├↓', '├|1', '└|1', '└'])
        // Everything under the chief folded.
        expect(drawn([0, 0, 1])).toEqual(['·', '·↓', '└'])
    })

    test('T39 guides: rows of roots alone draw nothing', () => {
        expect(drawn([0, 0, 0])).toEqual(['·', '·', '·'])
        expect(treeGuidesFor([])).toEqual([])
    })
})
