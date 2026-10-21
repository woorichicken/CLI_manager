import { test, expect } from '@playwright/test'
import { MAX_TREE_DEPTH, sessionTreeFor } from '../../src/renderer/src/utils/relatedSessions'
import type { SessionRelation, TerminalSession, Workspace } from '../../src/shared/types'

/**
 * T37 — Session tree (the Related dialog's relation tab), pure logic (no Electron).
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

test.describe('T37 session tree', () => {
    test('T37 tree: siblings come from the shared parent', () => {
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

    test('T37 tree: a cycle of connected relations ends', () => {
        const relations = [rel('A', 'B', 'connected'), rel('B', 'C', 'connected'), rel('C', 'A', 'connected')]
        const tree = sessionTreeFor(relations, 'A', workspaces(['A', 'B', 'C']))
        const all = [...ids(tree.ancestors), ...ids(tree.siblings), ...ids(tree.descendants)]
        // Every other session shows once, and the walk comes back at all.
        expect(all.sort()).toEqual(['B', 'C'])
    })

    test('T37 tree: dismissed pairs and manual pairs stay out of the tree', () => {
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

    test('T37 tree: two parents show both above, siblings are not repeated', () => {
        const relations = [
            rel('P', 'S', 'opened'), rel('Q', 'S', 'connected'),
            rel('P', 'X'), rel('Q', 'X', 'connected'), rel('Q', 'Y')
        ]
        const tree = sessionTreeFor(relations, 'S', workspaces(['P', 'Q', 'S', 'X', 'Y']))
        expect(ids(tree.ancestors).sort()).toEqual(['P', 'Q'])
        expect(ids(tree.siblings).sort()).toEqual(['X', 'Y'])
    })

    test('T37 tree: a closed middle session cuts what hangs under it', () => {
        const relations = [rel('A', 'M'), rel('M', 'leaf')]
        const tree = sessionTreeFor(relations, 'A', workspaces(['A', 'leaf']))
        expect(tree.descendants).toEqual([])
    })

    test('T37 tree: depth is numbered and capped', () => {
        const chain = Array.from({ length: MAX_TREE_DEPTH + 3 }, (_, i) => `n${i}`)
        const relations = chain.slice(1).map((id, i) => rel(chain[i], id))
        const tree = sessionTreeFor(relations, 'n0', workspaces(chain))
        expect(tree.descendants.map(e => e.depth)).toEqual(Array.from({ length: MAX_TREE_DEPTH }, (_, i) => i + 1))
    })
})
