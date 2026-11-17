import { MessagesSquare, Plus } from 'lucide-react'

export type AllSessionsLayout = 'list' | 'tree'

interface AllSessionsToolbarProps {
    /** The List / Tree switch; hidden when Settings turns the tree off or there is nothing to arrange. */
    showLayoutSwitch: boolean
    layout: AllSessionsLayout
    onChooseLayout: (layout: AllSessionsLayout) => void
    /** False when there is no project to start a session in. */
    canCreate: boolean
    /** Opens the New session dialog (drawn by the sidebar, outside this list). */
    onNewSession: () => void
    newSessionOpen: boolean
    /** The Threads list (its own icon, not a third layout): on, it replaces the list; off, back to List/Tree. */
    threadsOpen: boolean
    onToggleThreads: () => void
    /** threads waiting for the person; the icon's badge, none at 0 */
    waitingThreads: number
}

/**
 * The row above the All sessions list: List / Tree on the left, "New session" on
 * the right (report c63a93c0). It lives here and not in the header so the header
 * keeps the folder view's button count — the title is not cut at the default width
 * and the view toggle stays where it is.
 *
 * The dialog itself is drawn by the sidebar outside the list: inside it, the
 * list's pointer tracking would treat the dialog as "pointer in the list" and hold
 * the new session's place in the recent order back.
 */
export function AllSessionsToolbar({
    showLayoutSwitch,
    layout,
    onChooseLayout,
    canCreate,
    onNewSession,
    newSessionOpen,
    threadsOpen,
    onToggleThreads,
    waitingThreads
}: AllSessionsToolbarProps) {
    return (
        <div className="flex items-center gap-1 px-1 pb-1.5" data-testid="all-sessions-toolbar">
            {showLayoutSwitch && (
                <div className={`flex items-center gap-1 transition-opacity ${threadsOpen ? 'opacity-50' : ''}`} role="group" aria-label="All sessions layout">
                    {(['list', 'tree'] as const).map(option => (
                        <button
                            key={option}
                            data-testid={`all-sessions-layout-${option}`}
                            aria-pressed={layout === option}
                            data-dimmed={threadsOpen ? 'true' : undefined}
                            onClick={() => onChooseLayout(option)}
                            className={`px-2 py-0.5 rounded text-[11px] border transition-colors ${
                                layout === option
                                    ? 'border-blue-500/50 bg-blue-500/15 text-blue-200'
                                    : 'border-white/10 text-gray-400 hover:bg-white/5'
                            }`}
                            title={option === 'tree' ? 'Each session under the session that opened it' : 'Session folders, then the rest'}
                        >
                            {option === 'tree' ? 'Tree' : 'List'}
                        </button>
                    ))}
                </div>
            )}
            <button
                data-testid="all-sessions-threads"
                aria-pressed={threadsOpen}
                aria-label={waitingThreads > 0 ? `Threads (${waitingThreads} waiting for you)` : 'Threads'}
                onClick={onToggleThreads}
                className={`relative shrink-0 flex items-center justify-center w-[26px] h-[22px] rounded border transition-colors ${
                    threadsOpen
                        ? 'border-blue-500/50 bg-blue-500/15 text-blue-200'
                        : 'border-white/10 text-gray-400 hover:bg-white/5'
                }`}
                title={threadsOpen ? 'Back to the session list' : 'Every thread in the app'}
            >
                <MessagesSquare size={13} />
                {waitingThreads > 0 && (
                    <span
                        data-testid="all-sessions-threads-badge"
                        className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-amber-500 text-[#1a1204] text-[10px] font-bold leading-[15px] text-center"
                    >
                        {waitingThreads}
                    </span>
                )}
            </button>
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
