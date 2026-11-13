import { test, expect } from '@playwright/test'
import { mostRecentOtherSession, orderByRecent, orderForAllSessions, sessionsInSidebarOrder } from '../../src/renderer/src/utils/sessionNavigation'
import { findMatchingSessions } from '../../src/renderer/src/components/Sidebar/SidebarSearch'
import { holdOrderFor, isOrderHeldFor, stepInOrder } from '../../src/renderer/src/utils/allSessionsNav'
import { dragScrollStep, DRAG_SCROLL_EDGE_PX, DRAG_SCROLL_MAX_STEP_PX } from '../../src/renderer/src/utils/dragAutoScroll'
import type { TerminalSession, Workspace, WorkspaceFolder } from '../../src/shared/types'

/**
 * T47 — "All sessions" ordering and session-name matching, pure logic (no Electron).
 */

const session = (id: string, name = id): TerminalSession => ({ id, name, cwd: '/tmp', type: 'regular' })
const workspace = (id: string, sessionIds: string[], extra: Partial<Workspace> = {}): Workspace =>
    ({ id, name: id, path: '/tmp', sessions: sessionIds.map(s => session(s)), createdAt: 0, ...extra } as Workspace)

const folders: WorkspaceFolder[] = [{ id: 'f1', name: 'f1', isExpanded: false, createdAt: 0 } as WorkspaceFolder]
const ids = (entries: { session: TerminalSession }[]) => entries.map(e => e.session.id)

test.describe('T47 sidebar session order', () => {
    const all = [
        workspace('home', ['h1'], { isHome: true }),
        workspace('pin', ['p1'], { isPinned: true }),
        workspace('inFolder', ['f1a', 'f1b'], { folderId: 'f1' }),
        workspace('loose', ['l1']),
        workspace('looseWt', ['w1'], { parentWorkspaceId: 'loose' }),
        workspace('play', ['g1'], { isPlayground: true })
    ]

    test('sessions follow the sidebar: home, pinned, folders, loose + worktrees, playground', () => {
        expect(ids(sessionsInSidebarOrder(all, folders, true, true)))
            .toEqual(['h1', 'p1', 'f1a', 'f1b', 'l1', 'w1', 'g1'])
    })

    test('hidden worktrees and playground stay out of the list', () => {
        expect(ids(sessionsInSidebarOrder(all, folders, false, false)))
            .toEqual(['h1', 'p1', 'f1a', 'f1b', 'l1'])
    })

    test('recent first, then never-viewed in sidebar order; unknown and repeated ids are ignored', () => {
        const entries = sessionsInSidebarOrder(all, folders, true, true)
        expect(ids(orderByRecent(entries, ['g1', 'gone', 'l1', 'g1'])))
            .toEqual(['g1', 'l1', 'h1', 'p1', 'f1a', 'f1b', 'w1'])
        expect(ids(orderByRecent(entries, []))).toEqual(ids(entries))
    })

    test('pinned sessions come first in sidebar order, however recently the others were viewed', () => {
        const withPins = all.map(w => w.id === 'loose' || w.id === 'inFolder'
            ? { ...w, sessions: w.sessions.map(s => s.id === 'l1' || s.id === 'f1b' ? { ...s, isPinned: true } : s) }
            : w)
        const entries = sessionsInSidebarOrder(withPins, folders, true, true)
        // l1 was viewed after f1b, but pins keep the sidebar order (f1b's folder comes before loose).
        expect(ids(orderForAllSessions(entries, ['g1', 'l1', 'f1b', 'h1'])))
            .toEqual(['f1b', 'l1', 'g1', 'h1', 'p1', 'f1a', 'w1'])
    })

    test('closing from the list lands on the session viewed before it, skipping closed ones', () => {
        const entries = sessionsInSidebarOrder(all, folders, true, true)
        expect(mostRecentOtherSession(entries, ['l1', 'gone', 'g1', 'h1'], 'l1')?.session.id).toBe('g1')
        // Closing one that was not the latest still picks the latest other one.
        expect(mostRecentOtherSession(entries, ['g1', 'l1'], 'l1')?.session.id).toBe('g1')
        expect(mostRecentOtherSession(entries, ['l1'], 'l1')).toBeNull()
        expect(mostRecentOtherSession(entries, [], 'l1')).toBeNull()
    })

    test('name match: prefix before contains, case-insensitive, keeps sidebar order within a rank', () => {
        const entries = [
            { workspace: all[0], session: session('a', 'review notes') },
            { workspace: all[1], session: session('b', 'Deploy') },
            { workspace: all[2], session: session('c', 'redeploy') },
            { workspace: all[3], session: session('d', 'deploy two') }
        ]
        expect(ids(findMatchingSessions(entries, ' DEPLOY '))).toEqual(['b', 'd', 'c'])
        expect(findMatchingSessions(entries, '   ')).toEqual([])
        expect(findMatchingSessions(entries, 'nope')).toEqual([])
    })

    test('Cmd+[ / ] steps through the All sessions rows and wraps (dc11b60f)', () => {
        const order = ['a', 'b', 'c']
        expect(stepInOrder(order, 'a', 1)).toBe('b')
        expect(stepInOrder(order, 'c', 1)).toBe('a')
        expect(stepInOrder(order, 'a', -1)).toBe('c')
        expect(stepInOrder(order, 'b', -1)).toBe('a')
        // Not on screen (collapsed folder, nothing active): from the top down, from the bottom up.
        expect(stepInOrder(order, 'zz', 1)).toBe('a')
        expect(stepInOrder(order, null, -1)).toBe('c')
        expect(stepInOrder([], 'a', 1)).toBeNull()
    })

    test('a keyboard step holds the list order only while that session stays active', () => {
        holdOrderFor('b')
        expect(isOrderHeldFor('b')).toBe(true)
        expect(isOrderHeldFor('b')).toBe(true)
        // Another session became active some other way: the hold is gone for good.
        expect(isOrderHeldFor('c')).toBe(false)
        expect(isOrderHeldFor('b')).toBe(false)
        expect(isOrderHeldFor(null)).toBe(false)
    })

    test('a dragged row scrolls the list only near its edges, faster closer in (0edb46cc)', () => {
        const edge = DRAG_SCROLL_EDGE_PX
        const max = DRAG_SCROLL_MAX_STEP_PX
        expect(dragScrollStep(300, 100, 700)).toBe(0)
        expect(dragScrollStep(100 + edge, 100, 700)).toBe(0)
        expect(dragScrollStep(700 - edge, 100, 700)).toBe(0)
        expect(dragScrollStep(100 + edge - 1, 100, 700)).toBeLessThan(0)
        expect(dragScrollStep(700 - edge + 1, 100, 700)).toBeGreaterThan(0)
        expect(dragScrollStep(101, 100, 700)).toBeLessThan(dragScrollStep(120, 100, 700))
        // At or past an edge (over the header above, the badge below): full speed.
        expect(dragScrollStep(100, 100, 700)).toBe(-max)
        expect(dragScrollStep(40, 100, 700)).toBe(-max)
        expect(dragScrollStep(760, 100, 700)).toBe(max)
        // A list too short for two edge zones never scrolls.
        expect(dragScrollStep(100, 100, 100 + edge * 2)).toBe(0)
    })
})
