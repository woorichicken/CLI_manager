import { useEffect, useRef } from 'react'
import { Search, X } from 'lucide-react'
import { Workspace, WorkspaceFolder } from '../../../../shared/types'
import type { SessionEntry } from '../../utils/sessionNavigation'

// Ranks keep the result the user most likely meant on top, so Enter opens it.
const RANK_NAME_PREFIX = 0
const RANK_NAME_CONTAINS = 1
const RANK_OTHER_FIELD = 2

/**
 * Projects (top-level workspaces) whose name, path, sidebar folder or worktree
 * matches the query. Worktrees and playgrounds are not results of their own:
 * a worktree shows up under its parent, and playgrounds keep their own section.
 */
export function findMatchingProjects(
    workspaces: Workspace[],
    folders: WorkspaceFolder[],
    query: string,
    includeWorktrees: boolean
): Workspace[] {
    const q = query.trim().toLowerCase()
    if (!q) return []

    const folderNames = new Map(folders.map(f => [f.id, f.name.toLowerCase()]))
    const contains = (value?: string) => Boolean(value) && value!.toLowerCase().includes(q)

    const rankOf = (workspace: Workspace): number | null => {
        const name = workspace.name.toLowerCase()
        if (name.startsWith(q)) return RANK_NAME_PREFIX
        if (name.includes(q)) return RANK_NAME_CONTAINS
        if (contains(workspace.path)) return RANK_OTHER_FIELD
        if (workspace.folderId && folderNames.get(workspace.folderId)?.includes(q)) return RANK_OTHER_FIELD
        if (includeWorktrees && workspaces.some(child =>
            child.parentWorkspaceId === workspace.id && (contains(child.name) || contains(child.branchName))
        )) return RANK_OTHER_FIELD
        return null
    }

    return workspaces
        .filter(w => !w.isPlayground && !w.parentWorkspaceId)
        .map((workspace, index) => ({ workspace, index, rank: rankOf(workspace) }))
        .filter((r): r is { workspace: Workspace; index: number; rank: number } => r.rank !== null)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(r => r.workspace)
}

/**
 * Sessions whose own name matches, in the order the caller gave (sidebar order).
 * A name that starts with the query comes before one that merely contains it,
 * so Enter lands on the closest name.
 */
export function findMatchingSessions(entries: SessionEntry[], query: string): SessionEntry[] {
    const q = query.trim().toLowerCase()
    if (!q) return []

    return entries
        .map((entry, index) => {
            const name = entry.session.name.toLowerCase()
            const rank = name.startsWith(q) ? RANK_NAME_PREFIX : name.includes(q) ? RANK_NAME_CONTAINS : null
            return { entry, index, rank }
        })
        .filter((r): r is { entry: SessionEntry; index: number; rank: number } => r.rank !== null)
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map(r => r.entry)
}

interface SidebarSearchInputProps {
    query: string
    onQueryChange: (query: string) => void
    /** Enter: open the top result. */
    onSubmit: () => void
    onClose: () => void
}

/**
 * Search row under the sidebar header. Escape clears and closes it.
 */
export function SidebarSearchInput({ query, onQueryChange, onSubmit, onClose }: SidebarSearchInputProps) {
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    return (
        <div className="px-2 pt-2">
            <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-white/10 bg-white/5 focus-within:border-blue-500/60">
                <Search size={12} className="text-gray-500 shrink-0" />
                <input
                    ref={inputRef}
                    data-testid="sidebar-search-input"
                    className="flex-1 min-w-0 bg-transparent text-xs text-gray-300 outline-none placeholder:text-gray-500"
                    placeholder="Search projects and sessions"
                    value={query}
                    onChange={e => onQueryChange(e.target.value)}
                    onKeyDown={e => {
                        if (e.key === 'Enter') {
                            e.preventDefault()
                            onSubmit()
                        }
                        if (e.key === 'Escape') {
                            e.preventDefault()
                            onClose()
                        }
                    }}
                />
                {query && (
                    <button
                        onClick={() => {
                            onQueryChange('')
                            inputRef.current?.focus()
                        }}
                        className="p-0.5 hover:bg-white/10 rounded transition-colors shrink-0"
                        title="Clear search"
                    >
                        <X size={12} className="text-gray-400" />
                    </button>
                )}
            </div>
        </div>
    )
}

interface SidebarSearchStatusProps {
    query: string
    projectCount: number
    sessionCount: number
}

/** The empty state, or the "Projects" heading above the project results. */
export function SidebarSearchStatus({ query, projectCount, sessionCount }: SidebarSearchStatusProps) {
    if (projectCount === 0 && sessionCount === 0) {
        return (
            <div data-testid="sidebar-search-empty" className="px-2 py-3 text-xs text-gray-500">
                No projects or sessions match “{query.trim()}”
            </div>
        )
    }
    if (projectCount === 0) return null
    return <SidebarGroupHeading label={projectCount === 1 ? 'project' : 'projects'} count={projectCount} />
}

/** "2 projects" / "3 sessions": the heading of one result group. */
export function SidebarGroupHeading({ label, count, testId }: { label: string; count: number; testId?: string }) {
    return (
        <div className="px-2 pt-1 pb-0.5" data-testid={testId}>
            <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                {count} {label}
            </span>
        </div>
    )
}
