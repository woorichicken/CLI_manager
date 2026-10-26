import { Hash, StickyNote, X } from 'lucide-react'
import { SessionPeek, SessionRelationKind, TerminalSession, Workspace } from '../../../../shared/types'
import { isTalkSession } from '../../utils/relatedSessions'

type PeekState = SessionPeek['state'] | 'awaiting'

const STATE_LABELS: Record<PeekState, string> = {
    awaiting: 'Waiting for you',
    busy: 'Working',
    idle: 'Idle',
    starting: 'Starting',
    exited: 'Exited'
}

// Same colors as the sidebar's status dots, so a glance means the same thing in both places.
const STATE_DOTS: Record<PeekState, string> = {
    awaiting: 'bg-amber-400 animate-pulse',
    busy: 'bg-blue-500 animate-pulse',
    idle: 'bg-gray-500',
    starting: 'bg-gray-600',
    exited: 'bg-red-500/70'
}

function peekState(peek: SessionPeek | undefined): PeekState | null {
    if (!peek) return null
    return peek.awaitingInput ? 'awaiting' : peek.state
}

/** A row needs no relation: the Recent and All tabs list sessions that merely exist. */
export interface RowEntry {
    session: TerminalSession
    workspace: Workspace
    kind?: SessionRelationKind
}

interface RelatedSessionRowProps {
    entry: RowEntry
    peek: SessionPeek | undefined
    selected: boolean
    /** The split view is full (this session plus three); only already-selected rows can change. */
    selectionFull: boolean
    onToggle: (sessionId: string) => void
    onShow: (sessionId: string) => void
    /** Left out where "remove from related" means nothing (Recent, All). */
    onRemove?: (sessionId: string) => void
    /** No state dot or label: the All tab does not poll every session. */
    hideState?: boolean
    /** Copies the session id (what the AI Control API calls it). */
    onCopyId: (sessionId: string) => void
    /** Levels of indentation in the relation tree; 0 for a flat list. */
    indent?: number
}

/** Each tree level steps in by this much; the cap keeps a deep chain readable in a narrow window. */
const INDENT_STEP_PX = 12
const MAX_INDENT_LEVELS = 3
const BASE_PADDING_PX = 16

export function RelatedSessionRow({ entry, peek, selected, selectionFull, onToggle, onShow, onRemove, onCopyId, indent = 0, hideState = false }: RelatedSessionRowProps) {
    const { session, workspace, kind } = entry
    const state = peekState(peek)
    // The first line written on any memo page (page 1 may be empty while a later one is not).
    const memo = [session.memo ?? '', ...(session.memoPages ?? [])].join('\n').split('\n').find(line => line.trim())?.trim()

    return (
        <div
            style={{ paddingLeft: BASE_PADDING_PX + Math.min(indent, MAX_INDENT_LEVELS) * INDENT_STEP_PX }}
            className={`flex items-start gap-2 pr-4 py-2 transition-colors ${selected ? 'bg-blue-500/10' : 'hover:bg-white/5'}`}
            data-related-row={session.id}
            data-related-kind={kind}
        >
            <input
                type="checkbox"
                checked={selected}
                disabled={!selected && selectionFull}
                onChange={() => onToggle(session.id)}
                className="mt-1 accent-blue-500 disabled:opacity-30"
                title={!selected && selectionFull ? 'Split view holds 4 sessions: this one and 3 more' : 'Select to open beside this session'}
                data-related-select={session.id}
            />
            <button
                onClick={() => onShow(session.id)}
                className="flex-1 min-w-0 text-left"
                title="Go to this session"
                data-related-open={session.id}
            >
                <div className="flex items-center gap-2 min-w-0">
                    {!hideState && (
                        <span
                            className={`w-2 h-2 rounded-full shrink-0 ${state ? STATE_DOTS[state] : 'bg-gray-700'}`}
                        />
                    )}
                    <span className="text-sm text-gray-200 truncate">{session.name}</span>
                    {isTalkSession(session.name) && (
                        <span
                            className="shrink-0 px-1.5 py-px rounded-full bg-violet-500/15 border border-violet-500/30 text-[10px] text-violet-300"
                            title="Opened for you to talk in. Agents leave it open until you ask them to close it."
                            data-talk-badge={session.id}
                        >
                            Talk
                        </span>
                    )}
                    {kind === 'connected' && (
                        <span
                            className="shrink-0 px-1.5 py-px rounded-full bg-white/5 text-[10px] text-gray-400"
                            title="Not opened by the API: the agent started working in a session that already existed."
                        >
                            connected
                        </span>
                    )}
                    <span className={`hidden min-[480px]:inline text-xs text-gray-500 truncate ${hideState ? 'ml-auto' : ''}`} title={`Project: ${workspace.name}`}>{workspace.name}</span>
                    {!hideState && (
                        <span
                            className="ml-auto shrink-0 text-[11px] text-gray-400"
                            data-related-state={state ?? ''}
                        >
                            {state ? STATE_LABELS[state] : ''}
                        </span>
                    )}
                </div>
                {peek?.lastLine && peek.lastLineIsRecap && (
                    // The agent's own summary is a sentence: read from its start, over two lines at most.
                    <div
                        className="mt-0.5 pl-4 text-[11px] text-gray-400 line-clamp-2 break-words"
                        title={peek.lastLine}
                        data-related-last-line={session.id}
                        data-related-recap
                    >
                        {peek.lastLine}
                    </div>
                )}
                {peek?.lastLine && !peek.lastLineIsRecap && (
                    // A prompt ends with where the session is, so a long line is cut at the front (rtl box), not the end.
                    // The bdi keeps the text itself left-to-right.
                    <div className="mt-0.5 pl-4 font-mono text-[11px] text-gray-500 truncate text-left [direction:rtl]" data-related-last-line={session.id}>
                        <bdi dir="ltr">{peek.lastLine}</bdi>
                    </div>
                )}
                {memo && (
                    <div className="mt-0.5 pl-4 flex items-center gap-1 text-[11px] text-amber-200/70 min-w-0" data-related-memo={session.id}>
                        <StickyNote size={10} className="shrink-0" />
                        <span className="truncate">{memo}</span>
                    </div>
                )}
            </button>
            <button
                onClick={() => onCopyId(session.id)}
                className="mt-0.5 p-1 rounded hover:bg-white/10 text-gray-500 hover:text-gray-200 transition-colors"
                title={`Copy session ID — ${session.id}`}
                data-related-copy-id={session.id}
            >
                <Hash size={12} />
            </button>
            {onRemove && (
                <button
                    onClick={() => onRemove(session.id)}
                    className="mt-0.5 p-1 rounded hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors"
                    title="Remove from related sessions (the session keeps running)"
                    data-related-remove={session.id}
                >
                    <X size={12} />
                </button>
            )}
        </div>
    )
}
