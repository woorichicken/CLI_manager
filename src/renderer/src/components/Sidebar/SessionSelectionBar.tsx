import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { MAX_LINKED_SESSIONS } from '../../utils/sessionLink'

/** How long "Copied" stays on the button before it reads "Copy IDs" again. */
const COPIED_VISIBLE_MS = 1500

/** What a sidebar row needs to draw and toggle its check box. */
export interface SessionSelection {
    /** Something is picked: every row shows its box, not only the hovered one. */
    active: boolean
    isSelected: (sessionId: string) => boolean
    toggle: (sessionId: string) => void
}

/**
 * Sessions picked with the row check boxes in the All sessions view (0d1e3d34),
 * in the order they were picked. Ids of sessions that no longer exist are dropped
 * so a closed session never ends up in a copy or a split.
 */
export function useSessionSelection(existingIds: ReadonlySet<string>) {
    const [picked, setPicked] = useState<string[]>([])
    const selected = useMemo(() => picked.filter(id => existingIds.has(id)), [picked, existingIds])

    const toggle = useCallback((sessionId: string) => {
        setPicked(prev => (prev.includes(sessionId) ? prev.filter(id => id !== sessionId) : [...prev, sessionId]))
    }, [])
    const clear = useCallback(() => setPicked([]), [])

    const selection: SessionSelection = useMemo(() => {
        const set = new Set(selected)
        return { active: set.size > 0, isSelected: (id: string) => set.has(id), toggle }
    }, [selected, toggle])

    return { selected, selection, clear }
}

interface SessionSelectionBarProps {
    selected: string[]
    onShowSessions: (sessionIds: string[]) => void
    onClear: () => void
}

/**
 * "N selected · Side by side · Copy IDs · ✕" under the All sessions list.
 * Copy IDs puts the full ids on the clipboard one per line, in the order they
 * were picked — ready for `clim read <id>` or a `for id in $(pbpaste)` loop.
 * Side by side is the Related dialog's "Open side by side": split view holds
 * MAX_LINKED_SESSIONS, so it is off for more.
 */
export function SessionSelectionBar({ selected, onShowSessions, onClear }: SessionSelectionBarProps) {
    const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current)
    }, [])

    if (selected.length === 0) return null

    const canSplit = selected.length >= 2 && selected.length <= MAX_LINKED_SESSIONS
    const copyIds = async () => {
        let result: 'ok' | 'failed' = 'ok'
        try {
            await navigator.clipboard.writeText(selected.join('\n'))
        } catch (err) {
            result = 'failed'
            console.error('Failed to copy session IDs:', err)
        }
        setCopied(result)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = setTimeout(() => setCopied(null), COPIED_VISIBLE_MS)
    }

    return (
        // Two rows: at the default sidebar width (256px) the count, two buttons and ✕ do not fit on one.
        <div
            data-testid="session-selection-bar"
            role="toolbar"
            aria-label="Selected sessions"
            className="shrink-0 mx-2 mb-2 px-2 py-1.5 rounded border border-blue-500/30 bg-[#1b2230] text-xs"
            onKeyDown={(e) => {
                if (e.key === 'Escape') {
                    e.stopPropagation()
                    onClear()
                }
            }}
        >
            <div className="flex items-center gap-1.5">
                <span data-testid="session-selection-count" className="text-gray-300 truncate min-w-0 mr-auto">
                    {selected.length} selected
                </span>
                <button
                    data-testid="session-selection-clear"
                    onClick={onClear}
                    title="Clear selection (Esc)"
                    aria-label="Clear selection"
                    className="shrink-0 p-0.5 rounded text-gray-500 hover:text-gray-200 hover:bg-white/10"
                >
                    <X size={12} />
                </button>
            </div>
            <div className="flex items-center gap-1.5 mt-1.5">
            <button
                data-testid="session-selection-split"
                disabled={!canSplit}
                onClick={() => onShowSessions(selected)}
                title={canSplit ? 'Open these side by side' : `Side by side needs 2–${MAX_LINKED_SESSIONS} sessions`}
                className="flex-1 min-w-0 truncate px-2 py-0.5 rounded border border-blue-500/40 text-blue-200 hover:bg-blue-500/15 disabled:opacity-40 disabled:hover:bg-transparent"
            >
                Side by side
            </button>
            <button
                data-testid="session-selection-copy"
                onClick={copyIds}
                title="Copy the session IDs, one per line"
                className="flex-1 min-w-0 truncate px-2 py-0.5 rounded border border-white/15 text-gray-300 hover:bg-white/5"
            >
                {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy IDs'}
            </button>
            </div>
        </div>
    )
}
