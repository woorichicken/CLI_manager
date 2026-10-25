import { TerminalSession, Workspace, WorkspaceFolder } from '../../../shared/types'

/**
 * Workspaces in the order the sidebar draws them, so Cmd+Shift+[ / ] moves to
 * the row above or below instead of jumping by an order the user never sees.
 *
 * Mirrors Sidebar/index.tsx: home, pinned, folders (in folder order), unfoldered,
 * then playgrounds — each top-level workspace followed by its worktrees when
 * those are shown (playgrounds only while `showPlayground`). `workspaces` must already be in display order (sortedWorkspaces).
 */
export function sidebarWorkspaceOrder(
    workspaces: Workspace[],
    folders: WorkspaceFolder[],
    showWorktrees: boolean,
    showPlayground = true
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
    const playgrounds = showPlayground ? workspaces.filter(w => w.isPlayground) : []

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

/** Where closing the session on screen takes the user — see App's handleRemoveSession. */
export type SessionLanding = 'neighbor' | 'recent'

/** A session together with the workspace row it lives under. */
export interface SessionEntry {
    workspace: Workspace
    session: TerminalSession
}

/** Every session in the order the sidebar draws them (workspace order, then each workspace's own session order). */
export function sessionsInSidebarOrder(
    workspaces: Workspace[],
    folders: WorkspaceFolder[],
    showWorktrees: boolean,
    showPlayground = true
): SessionEntry[] {
    return sidebarWorkspaceOrder(workspaces, folders, showWorktrees, showPlayground)
        .flatMap(workspace => (workspace.sessions ?? []).map(session => ({ workspace, session })))
}

/**
 * The "All sessions" order: sessions the user looked at lately first (newest
 * first), then the ones never looked at in sidebar order. Ids that no longer
 * exist are ignored.
 */
export function orderByRecent(entries: SessionEntry[], recentIds: string[]): SessionEntry[] {
    const byId = new Map(entries.map(entry => [entry.session.id, entry]))
    const seen = new Set<string>()
    const recent: SessionEntry[] = []
    for (const id of recentIds) {
        const entry = byId.get(id)
        if (entry && !seen.has(id)) {
            seen.add(id)
            recent.push(entry)
        }
    }
    return [...recent, ...entries.filter(entry => !seen.has(entry.session.id))]
}

/**
 * The "All sessions" list: pinned sessions first, in sidebar order so they stay
 * where the user put them, then everything else by `orderByRecent`.
 */
export function orderForAllSessions(entries: SessionEntry[], recentIds: string[]): SessionEntry[] {
    const pinned = entries.filter(entry => entry.session.isPinned)
    const rest = entries.filter(entry => !entry.session.isPinned)
    return [...pinned, ...orderByRecent(rest, recentIds)]
}

/**
 * Where to land after closing `closingId` from the "All sessions" list: the
 * session looked at most recently before it that still exists. Null when the
 * user has looked at no other session yet.
 */
export function mostRecentOtherSession(entries: SessionEntry[], recentIds: string[], closingId: string): SessionEntry | null {
    const byId = new Map(entries.map(entry => [entry.session.id, entry]))
    for (const id of recentIds) {
        if (id === closingId) continue
        const entry = byId.get(id)
        if (entry) return entry
    }
    return null
}
