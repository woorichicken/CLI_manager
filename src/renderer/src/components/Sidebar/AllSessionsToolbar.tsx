import type React from 'react'
import { MessagesSquare, Plus } from 'lucide-react'
import { SidebarViewMenu, type SidebarView } from './SidebarViewMenu'

export type AllSessionsLayout = 'list' | 'tree'

/** The Threads icon — All sessions only. */
interface ThreadsToggle {
    open: boolean
    onToggle: () => void
    /** threads waiting for the person; the icon's badge, none at 0 */
    waiting: number
}

interface AllSessionsToolbarProps {
    /** The view on screen; the View ▾ chip names it. */
    view: SidebarView
    /** Settings › Sidebar › Show Session Tree: off, the dropdown has no Tree. */
    showTree: boolean
    onChooseView: (view: SidebarView) => void
    /** False when there is no project to start a session in. */
    canCreate: boolean
    /** Opens the New session dialog (drawn by the sidebar, outside the list). */
    onNewSession: () => void
    newSessionOpen: boolean
    /** All sessions only: on, the Threads list replaces the sessions; the dropdown dims meanwhile. */
    threads?: ThreadsToggle
    /** The role/tag filter button (decision 0015), drawn after the Threads icon. All sessions only. */
    labelFilter?: React.ReactNode
}

/**
 * The row above the sidebar list, in both views: View ▾ (Folders · List · Tree) on the left, "New
 * session" on the right (report c63a93c0). The dropdown replaced the header's view toggle and the
 * List / Tree buttons (view-filter-1127, person 11-27). All sessions adds the Threads icon and the
 * role/tag filter between them.
 *
 * It sits above the scrolling list, not in it: it holds the only way to change the view, so a long
 * list must not scroll it away. The New session dialog is drawn by the sidebar outside the list:
 * inside it, the list's pointer tracking would treat the dialog as "pointer in the list" and hold the
 * new session's place in the recent order back.
 */
export function AllSessionsToolbar({
    view,
    showTree,
    onChooseView,
    canCreate,
    onNewSession,
    newSessionOpen,
    threads,
    labelFilter
}: AllSessionsToolbarProps) {
    return (
        <div className="flex items-center gap-1 px-1 pb-1.5" data-testid="all-sessions-toolbar" data-view={view}>
            <SidebarViewMenu view={view} showTree={showTree} dimmed={threads?.open} onChoose={onChooseView} />
            {threads && (
                <button
                    data-testid="all-sessions-threads"
                    aria-pressed={threads.open}
                    aria-label={threads.waiting > 0 ? `Threads (${threads.waiting} waiting for you)` : 'Threads'}
                    onClick={threads.onToggle}
                    className={`relative shrink-0 flex items-center justify-center w-[26px] h-[22px] rounded border transition-colors ${
                        threads.open
                            ? 'border-blue-500/50 bg-blue-500/15 text-blue-200'
                            : 'border-white/10 text-gray-400 hover:bg-white/5'
                    }`}
                    title={threads.open ? 'Back to the session list' : 'Every thread in the app'}
                >
                    <MessagesSquare size={13} />
                    {threads.waiting > 0 && (
                        <span
                            data-testid="all-sessions-threads-badge"
                            className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-amber-500 text-[#1a1204] text-[10px] font-bold leading-[15px] text-center"
                        >
                            {threads.waiting}
                        </span>
                    )}
                </button>
            )}
            {labelFilter}
            <button
                data-testid="all-sessions-new-session"
                onClick={onNewSession}
                disabled={!canCreate}
                aria-haspopup="dialog"
                aria-expanded={newSessionOpen}
                className="ml-auto min-w-0 flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border border-white/10 text-gray-300 hover:text-white hover:bg-white/5 disabled:text-gray-600 disabled:hover:bg-transparent transition-colors"
                title={!canCreate ? 'Add a workspace first' : 'New session'}
            >
                <Plus size={12} className="shrink-0" />
                <span className="truncate">New session</span>
            </button>
        </div>
    )
}
