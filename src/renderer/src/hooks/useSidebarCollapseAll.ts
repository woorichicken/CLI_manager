import { useCallback, useMemo, useRef } from 'react'
import { Workspace, WorkspaceFolder } from '../../../shared/types'

interface UseSidebarCollapseAllOptions {
    workspaces: Workspace[]
    folders: WorkspaceFolder[]
    /** Workspaces whose session list is open (local sidebar state). */
    expanded: Set<string>
    setExpanded: (next: Set<string>) => void
    /** Folder open/closed state is persisted, so it goes through the app. */
    onSetFoldersExpanded: (folderIds: string[], expanded: boolean) => void
    showWorktrees: boolean
}

interface ExpansionSnapshot {
    folderIds: string[]
    workspaceIds: string[]
}

/**
 * One sidebar button that folds every folder and every session list, and on the
 * next press puts back exactly what was open before.
 *
 * Why restore instead of "expand everything": with dozens of workspaces, expanding
 * all of them buries the one the user was working in. Expanding everything is only
 * the fallback when there is nothing to restore (the user folded things by hand).
 */
export function useSidebarCollapseAll({
    workspaces,
    folders,
    expanded,
    setExpanded,
    onSetFoldersExpanded,
    showWorktrees
}: UseSidebarCollapseAllOptions) {
    const snapshotRef = useRef<ExpansionSnapshot | null>(null)

    // Only count what the user can actually see as open. A workspace that is
    // "expanded" inside a folded folder shows nothing, so it must not keep the
    // button in "Collapse All" mode with no visible effect.
    const anyExpanded = useMemo(() => {
        if (folders.some(f => f.isExpanded)) return true

        const byId = new Map(workspaces.map(w => [w.id, w]))
        const folderOpen = new Map(folders.map(f => [f.id, Boolean(f.isExpanded)]))
        const isVisible = (workspace: Workspace): boolean => {
            if (workspace.parentWorkspaceId) {
                if (!showWorktrees) return false
                const parent = byId.get(workspace.parentWorkspaceId)
                return Boolean(parent) && expanded.has(parent!.id) && isVisible(parent!)
            }
            // Pinned, home and playground rows render outside folders
            if (workspace.folderId && !workspace.isPinned && !workspace.isHome && !workspace.isPlayground) {
                return folderOpen.get(workspace.folderId) ?? false
            }
            return true
        }
        return workspaces.some(w => expanded.has(w.id) && isVisible(w))
    }, [workspaces, folders, expanded, showWorktrees])

    const collapseAll = useCallback(() => {
        const openFolderIds = folders.filter(f => f.isExpanded).map(f => f.id)
        snapshotRef.current = { folderIds: openFolderIds, workspaceIds: [...expanded] }
        setExpanded(new Set())
        onSetFoldersExpanded(openFolderIds, false)
    }, [folders, expanded, setExpanded, onSetFoldersExpanded])

    const expandAll = useCallback(() => {
        const snapshot = snapshotRef.current
        snapshotRef.current = null

        const existingWorkspaceIds = new Set(workspaces.map(w => w.id))
        const existingFolderIds = new Set(folders.map(f => f.id))
        const restoredWorkspaces = snapshot?.workspaceIds.filter(id => existingWorkspaceIds.has(id)) ?? []
        const restoredFolders = snapshot?.folderIds.filter(id => existingFolderIds.has(id)) ?? []

        if (restoredWorkspaces.length > 0 || restoredFolders.length > 0) {
            setExpanded(new Set(restoredWorkspaces))
            onSetFoldersExpanded(restoredFolders, true)
            return
        }

        setExpanded(new Set(workspaces.map(w => w.id)))
        onSetFoldersExpanded(folders.map(f => f.id), true)
    }, [workspaces, folders, setExpanded, onSetFoldersExpanded])

    return {
        anyExpanded,
        toggleCollapseAll: anyExpanded ? collapseAll : expandAll
    }
}
