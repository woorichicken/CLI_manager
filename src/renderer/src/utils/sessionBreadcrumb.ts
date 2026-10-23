import type { TerminalSession, Workspace, WorkspaceFolder } from '../../../shared/types'

export type BreadcrumbKind = 'folder' | 'project' | 'session'

export interface BreadcrumbSegment {
    kind: BreadcrumbKind
    label: string
    /** The Home workspace: its name is `user@host`, so the header shows a house and `~` instead. */
    isHome?: boolean
}

/**
 * Header path for a session: `folder > project > session`.
 *
 * The folder is the sidebar group the project sits in. A worktree has no
 * folder of its own — the sidebar nests it under its parent, so the parent's
 * folder is used. Playground projects and projects outside any folder drop
 * that segment rather than showing an empty one.
 */
export function buildSessionBreadcrumb(
    session: TerminalSession | null | undefined,
    workspace: Workspace | null | undefined,
    workspaces: Workspace[],
    folders: WorkspaceFolder[]
): BreadcrumbSegment[] {
    const segments: BreadcrumbSegment[] = []

    if (workspace && !workspace.isPlayground) {
        const parent = workspace.parentWorkspaceId
            ? workspaces.find(w => w.id === workspace.parentWorkspaceId)
            : undefined
        const folderId = workspace.folderId ?? parent?.folderId
        const folder = folderId ? folders.find(f => f.id === folderId) : undefined
        if (folder) segments.push({ kind: 'folder', label: folder.name })
    }
    if (workspace) segments.push({ kind: 'project', label: workspace.name, ...(workspace.isHome ? { isHome: true } : {}) })
    if (session) segments.push({ kind: 'session', label: session.name })

    return segments
}
