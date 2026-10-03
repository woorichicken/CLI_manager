import { TerminalSession, Workspace, WorkspaceFolder } from '../../../shared/types'

/**
 * Workspaces in the order the sidebar draws them, so Cmd+Shift+[ / ] moves to
 * the row above or below instead of jumping by an order the user never sees.
 *
 * Mirrors Sidebar/index.tsx: home, pinned, folders (in folder order), unfoldered,
 * then playgrounds — each top-level workspace followed by its worktrees when
 * those are shown. `workspaces` must already be in display order (sortedWorkspaces).
 */
export function sidebarWorkspaceOrder(
    workspaces: Workspace[],
    folders: WorkspaceFolder[],
    showWorktrees: boolean
): Workspace[] {
    const isTopLevel = (w: Workspace): boolean => !w.isPlayground && !w.parentWorkspaceId && !w.isHome
    const withWorktrees = (w: Workspace): Workspace[] => showWorktrees
        ? [w, ...workspaces.filter(child => child.parentWorkspaceId === w.id)]
        : [w]

    const home = workspaces.filter(w => w.isHome)
    const pinned = workspaces.filter(w => isTopLevel(w) && w.isPinned)
    const inFolders = folders.flatMap(folder =>
        workspaces.filter(w => isTopLevel(w) && !w.isPinned && w.folderId === folder.id))
    // A folderId pointing at a deleted folder renders nowhere; skip it like the sidebar does.
    const unfoldered = workspaces.filter(w => isTopLevel(w) && !w.isPinned && !w.folderId)
    const playgrounds = workspaces.filter(w => w.isPlayground)

    return [
        ...home,
        ...[...pinned, ...inFolders, ...unfoldered].flatMap(withWorktrees),
        ...playgrounds
    ]
}

/**
 * The tab to show after `sessionId` goes away: the one above it, or the one
 * below when it was first. Both Cmd+W and the sidebar's delete use this, so the
 * two never disagree about where the user lands.
 */
export function neighborSession(sessions: TerminalSession[], sessionId: string): TerminalSession | null {
    const index = sessions.findIndex(s => s.id === sessionId)
    if (index < 0) return null
    return sessions[index - 1] ?? sessions[index + 1] ?? null
}
