import { test, expect } from '@playwright/test'
import { orderByRecent, sessionsInSidebarOrder } from '../../src/renderer/src/utils/sessionNavigation'
import { findMatchingSessions } from '../../src/renderer/src/components/Sidebar/SidebarSearch'
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
})
