import { useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, Info, Plus, Waypoints, X } from 'lucide-react'
import { SessionRelation, TerminalTemplate, Workspace } from '../../../../shared/types'
import { RELATED_ORDERS, RelatedEntry, RelatedOrder, sessionTreeFor } from '../../utils/relatedSessions'
import { MAX_LINKED_SESSIONS } from '../../utils/sessionLink'
import { useSessionPeeks } from '../../hooks/useSessionPeeks'
import { RelationTree } from './RelationTree'
import { CopyNotice, useCopyWithNotice } from '../Sidebar/CopyNotice'
import { AddRelatedSession } from './AddRelatedSession'
import { NewRelatedSession } from './NewRelatedSession'

interface RelatedSessionsModalProps {
    sessionId: string
    workspaces: Workspace[]
    relations: SessionRelation[]
    onClose: () => void
    /** One id: show it as a sidebar click does. Several: side by side in split view. */
    onShowSessions: (sessionIds: string[]) => void
    /** What "New session" can run: the user's terminal templates. */
    templates: TerminalTemplate[]
    /** Starts a session the way the sidebar does and shows it; resolves to its id, or undefined when it failed. */
    onCreateSession: (workspaceId: string, template: TerminalTemplate, name: string) => Promise<string | undefined>
}

/** "Open side by side" puts this session in the first pane, so the others get the rest of the split view. */
const MAX_PICKED = MAX_LINKED_SESSIONS - 1

/** The dialog's order is a preference: it outlives the dialog and a restart. */
const ORDER_STORAGE_KEY = 'climanager.related.order'

function storedOrder(): RelatedOrder {
    try {
        const value = localStorage.getItem(ORDER_STORAGE_KEY)
        return RELATED_ORDERS.some(order => order.key === value) ? (value as RelatedOrder) : 'newest'
    } catch {
        return 'newest'
    }
}

function storeOrder(order: RelatedOrder): void {
    try {
        localStorage.setItem(ORDER_STORAGE_KEY, order)
    } catch {
        // Not remembered this time; the order still applies.
    }
}

/** What the labels on a row mean; shown under the header's (i) button. */
const HELP_LINES: Array<[string, string]> = [
    ['Talk', 'a session opened for you to talk in (named "대화: …")'],
    ['connected', 'not opened by the API: the agent started working in a session that already existed'],
    ['by hand', 'dragged onto a session in the sidebar, or added in this dialog — it goes under the session it was dropped on'],
    ['Grey text', "the session's project (workspace) name"],
    ['Idle / Working / Waiting for you / Starting / Exited', 'what the session is doing right now'],
    ['Dot', 'grey = idle · blue, pulsing = working · amber, pulsing = waiting for you · red = exited'],
    ['#', 'copy the session ID'],
    ['×', 'remove it from this list (the session keeps running)'],
    ['Drag', 'drop a session row onto another in the sidebar to put it under that one']
]

/**
 * The sessions that belong with this one, at a glance: state, last line and
 * memo of each, one click to go there, or several side by side.
 */
export function RelatedSessionsModal({ sessionId, workspaces, relations, onClose, onShowSessions, templates, onCreateSession }: RelatedSessionsModalProps) {
    const [order, setOrder] = useState<RelatedOrder>(storedOrder)
    const [recentIds, setRecentIds] = useState<string[]>([])
    const [creating, setCreating] = useState(false)
    const [helpPinned, setHelpPinned] = useState(false)
    const [helpHover, setHelpHover] = useState(false)
    const tree = useMemo(
        () => sessionTreeFor(relations, sessionId, workspaces, order, recentIds),
        [relations, sessionId, workspaces, order, recentIds]
    )
    const entries: RelatedEntry[] = useMemo(
        () => [...tree.descendants, ...tree.ancestors, ...tree.siblings, ...tree.other],
        [tree]
    )
    const { notice, copy } = useCopyWithNotice()
    const relatedIds = useMemo(() => new Set(entries.map(entry => entry.session.id)), [entries])
    // Only the related sessions are listed — every session is one click away in the sidebar's
    // All sessions view, so this dialog no longer repeats that list (reports c17aa9c4, 33f92744).
    const visibleIds = useMemo(() => entries.map(entry => entry.session.id), [entries])
    const peeks = useSessionPeeks(visibleIds)
    const [selected, setSelected] = useState<string[]>([])
    const panelRef = useRef<HTMLDivElement>(null)

    const owner = useMemo(() => {
        for (const workspace of workspaces) {
            const session = workspace.sessions?.find(s => s.id === sessionId)
            if (session) return session
        }
        return undefined
    }, [workspaces, sessionId])

    // A selected session that closed (or was removed) cannot be opened any more.
    const liveSelection = selected.filter(id => visibleIds.includes(id))

    // Read when the order that needs it is picked, not before: it is what the user looked at up to now.
    useEffect(() => {
        if (order !== 'viewed') return
        let cancelled = false
        window.api.getRecentSessions().then(ids => { if (!cancelled) setRecentIds(ids) }).catch(() => {})
        return () => { cancelled = true }
    }, [order])

    // Take focus from the terminal: keys typed while the dialog is open must not reach the shell.
    useEffect(() => {
        panelRef.current?.focus()
    }, [])

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                // Esc peels one layer: the New session box, then the help panel, then the Related dialog.
                if (creating) setCreating(false)
                else if (helpPinned || helpHover) { setHelpPinned(false); setHelpHover(false) }
                else onClose()
            }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [onClose, creating, helpPinned, helpHover])

    // A pinned help panel closes on a click anywhere else.
    useEffect(() => {
        if (!helpPinned) return
        const onMouseDown = (e: MouseEvent): void => {
            if (!(e.target as Element).closest('[data-related-help], [data-related-help-panel]')) setHelpPinned(false)
        }
        window.addEventListener('mousedown', onMouseDown, true)
        return () => window.removeEventListener('mousedown', onMouseDown, true)
    }, [helpPinned])

    // The session whose dialog this is was closed: nothing left to show.
    useEffect(() => {
        if (!owner) onClose()
    }, [owner, onClose])
    if (!owner) return null

    const toggle = (id: string): void => {
        setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id].slice(0, MAX_PICKED))
    }
    const show = (ids: string[]): void => {
        onShowSessions(ids)
        onClose()
    }
    const changeOrder = (next: RelatedOrder): void => {
        setOrder(next)
        storeOrder(next)
    }
    // The new session is listed with this one, then shown — the dialog has done its job.
    const createSession = async (workspaceId: string, template: TerminalTemplate, name: string): Promise<void> => {
        const newId = await onCreateSession(workspaceId, template, name)
        if (!newId) return
        await window.api.addSessionRelation(sessionId, newId)
        onClose()
    }

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div
                ref={panelRef}
                tabIndex={-1}
                className="relative w-full max-w-2xl glass-panel rounded-lg shadow-2xl overflow-hidden outline-none"
                data-related-modal={sessionId}
            >
                <div className="relative flex items-center gap-2 px-4 py-3 border-b border-white/10">
                    <Waypoints size={14} className="text-gray-400" />
                    <span className="text-sm text-white whitespace-nowrap">Related sessions</span>
                    <span className="text-xs text-gray-500 truncate">— {owner.name}</span>
                    <button
                        onClick={() => setHelpPinned(open => !open)}
                        onMouseEnter={() => setHelpHover(true)}
                        onMouseLeave={() => setHelpHover(false)}
                        className={`shrink-0 p-1 rounded transition-colors ${helpPinned ? 'text-white bg-white/10' : 'text-gray-500 hover:text-white hover:bg-white/10'}`}
                        title="What do these labels mean?"
                        aria-label="What do these labels mean?"
                        aria-expanded={helpPinned || helpHover}
                        data-related-help
                    >
                        <Info size={13} />
                    </button>
                    <button
                        onClick={() => setCreating(open => !open)}
                        className={`ml-auto shrink-0 flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${creating ? 'bg-white/10 text-white' : 'text-gray-400 hover:text-white hover:bg-white/10'}`}
                        title="Start a session and list it here"
                        aria-expanded={creating}
                        data-related-new
                    >
                        <Plus size={12} />
                        {/* A narrow window keeps the icon: the title and the session name need the room. */}
                        <span className="hidden min-[480px]:inline">New session</span>
                    </button>
                    <button onClick={onClose} className="p-1 hover:bg-white/10 rounded transition-colors" title="Close (Esc)">
                        <X size={14} className="text-gray-400" />
                    </button>
                    {/* Floats over the list instead of pushing it down; hover peeks, a click pins it. */}
                    {(helpPinned || helpHover) && (
                        <ul
                            className="absolute left-3 right-3 top-full z-20 px-3 py-2.5 space-y-1 rounded-lg border border-white/10 bg-gray-900/95 backdrop-blur shadow-xl text-[11px] text-gray-400"
                            data-related-help-panel
                            onMouseEnter={() => setHelpHover(true)}
                            onMouseLeave={() => setHelpHover(false)}
                        >
                            {HELP_LINES.map(([term, meaning]) => (
                                <li key={term}><span className="text-gray-200">{term}</span> — {meaning}</li>
                            ))}
                        </ul>
                    )}
                </div>

                {entries.length > 0 && (
                    <div className="flex items-center px-4 py-1.5 border-b border-white/10" data-related-toolbar>
                        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-gray-500">
                            Sort
                            <select
                                value={order}
                                onChange={e => changeOrder(e.target.value as RelatedOrder)}
                                className="bg-white/5 border border-white/10 rounded px-1.5 py-0.5 text-[11px] text-gray-200 outline-none focus:border-blue-500/50"
                                title="Order within each group. A session's own children stay under it."
                                data-related-order
                            >
                                {RELATED_ORDERS.map(item => (
                                    <option key={item.key} value={item.key} className="bg-gray-900">{item.label}</option>
                                ))}
                            </select>
                        </label>
                    </div>
                )}

                <div className="max-h-[50vh] overflow-y-auto py-1">
                    {entries.length === 0 && (
                        <div className="px-4 py-6 text-center text-xs text-gray-500" data-related-empty>
                            No related sessions yet. Sessions an agent here opens or works in through the
                            Control API show up on their own; add one by hand below.
                        </div>
                    )}
                    <RelationTree
                        tree={tree}
                        ownerName={owner.name}
                        peeks={peeks}
                        selected={liveSelection}
                        selectionFull={liveSelection.length >= MAX_PICKED}
                        onToggle={toggle}
                        onShow={id => show([id])}
                        onRemove={id => void window.api.removeSessionRelation(sessionId, id)}
                        onCopyId={id => void copy(id, 'session ID')}
                    />
                </div>

                {visibleIds.length > 0 && (
                    <div className="flex items-center gap-2 px-4 py-2 border-t border-white/10">
                        <span className="text-[11px] text-gray-500">
                            {liveSelection.length === 0
                                ? `Click a session to go there, or tick up to ${MAX_PICKED} to see them beside this one.`
                                : `${liveSelection.length} of ${MAX_PICKED} selected — opens beside this session`}
                        </span>
                        <button
                            onClick={() => show([sessionId, ...liveSelection])}
                            disabled={liveSelection.length === 0}
                            className="ml-auto flex items-center gap-1 px-2.5 py-1 rounded text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:bg-white/5 disabled:text-gray-500 disabled:cursor-not-allowed transition-colors"
                            data-related-open-split
                        >
                            <Columns2 size={12} />
                            Open side by side
                        </button>
                    </div>
                )}

                <AddRelatedSession
                    sessionId={sessionId}
                    workspaces={workspaces}
                    relatedIds={relatedIds}
                    onAdd={id => void window.api.addSessionRelation(sessionId, id)}
                />
                <CopyNotice notice={notice} />
            </div>
            {creating && (
                <NewRelatedSession
                    defaultWorkspaceId={workspaces.find(w => w.sessions?.some(s => s.id === sessionId))?.id ?? workspaces[0]?.id ?? ''}
                    workspaces={workspaces}
                    templates={templates}
                    onCreate={createSession}
                    onCancel={() => setCreating(false)}
                />
            )}
        </div>
    )
}
