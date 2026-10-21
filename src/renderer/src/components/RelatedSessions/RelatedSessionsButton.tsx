import { Waypoints } from 'lucide-react'

interface RelatedSessionsButtonProps {
    sessionId: string
    count: number
    onOpen: (sessionId: string) => void
    /** Split pane headers are 32px tall and crowded: icon and count only. */
    compact?: boolean
}

/**
 * Opens the Related sessions dialog of a session. Shown even at zero, because
 * the dialog is also where sessions are added by hand.
 */
export function RelatedSessionsButton({ sessionId, count, onOpen, compact = false }: RelatedSessionsButtonProps) {
    const title = count === 0
        ? 'Related sessions — none yet. Open to add one.'
        : `Related sessions (${count})`

    return (
        <button
            onClick={(e) => {
                // The split pane header selects its pane on click; opening the dialog should not.
                e.stopPropagation()
                onOpen(sessionId)
            }}
            className={`flex items-center gap-1 rounded transition-colors no-drag hover:bg-white/10 ${
                compact ? 'p-1' : 'px-2 py-1'
            } ${count > 0 ? 'text-gray-300' : 'text-gray-500'}`}
            title={title}
            data-related-button={sessionId}
            data-related-count={count}
        >
            <Waypoints size={compact ? 12 : 14} />
            {!compact && <span className="text-xs">Related</span>}
            {count > 0 && (
                <span className={`rounded-full bg-white/10 text-gray-200 tabular-nums ${compact ? 'px-1 text-[10px]' : 'px-1.5 text-[11px]'}`}>
                    {count}
                </span>
            )}
        </button>
    )
}
