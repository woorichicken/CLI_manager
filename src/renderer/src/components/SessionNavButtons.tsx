import { ChevronLeft, ChevronRight, CornerLeftUp } from 'lucide-react'
import { SessionHistory } from '../hooks/useSessionHistory'
import { RelatedEntry } from '../utils/relatedSessions'

interface SessionHistoryButtonsProps {
    history: SessionHistory
    onShow: (sessionId: string) => void
}

/** ‹ › in the session header: back and forward through the sessions shown, like a browser. */
export function SessionHistoryButtons({ history, onShow }: SessionHistoryButtonsProps) {
    const go = (target: string | undefined): void => {
        if (target) onShow(target)
    }
    const buttonClass = 'p-1 rounded transition-colors no-drag text-gray-400 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-default'

    return (
        <div className="flex items-center no-drag" data-session-history>
            <button
                onClick={() => go(history.goBack())}
                disabled={!history.canGoBack}
                className={buttonClass}
                title="Back to the previous session"
                data-session-back
            >
                <ChevronLeft size={16} />
            </button>
            <button
                onClick={() => go(history.goForward())}
                disabled={!history.canGoForward}
                className={buttonClass}
                title="Forward to the next session"
                data-session-forward
            >
                <ChevronRight size={16} />
            </button>
        </div>
    )
}

interface ParentSessionButtonProps {
    /** The sessions that opened this one. Shown only when there is exactly one: with more, Related lists them. */
    parents: RelatedEntry[]
    onShow: (sessionId: string) => void
}

/** A shortcut to the session that opened this one (an orchestrator, a team lead). */
export function ParentSessionButton({ parents, onShow }: ParentSessionButtonProps) {
    if (parents.length !== 1) return null
    const parent = parents[0].session
    return (
        <button
            onClick={() => onShow(parent.id)}
            className="flex items-center gap-1 max-w-[180px] px-2 py-1 rounded text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors no-drag"
            title={`Go to the session that opened this one: ${parent.name}`}
            data-parent-session={parent.id}
        >
            <CornerLeftUp size={13} className="shrink-0" />
            <span className="truncate">{parent.name}</span>
        </button>
    )
}
