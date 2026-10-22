import { useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, Waypoints, X } from 'lucide-react'
import { SessionRelation, Workspace } from '../../../../shared/types'
import { RelatedEntry, sessionTreeFor } from '../../utils/relatedSessions'
import { MAX_LINKED_SESSIONS } from '../../utils/sessionLink'
import { useSessionPeeks } from '../../hooks/useSessionPeeks'
import { RelationTree } from './RelationTree'
import { CopyNotice, useCopyWithNotice } from '../Sidebar/CopyNotice'
import { AddRelatedSession } from './AddRelatedSession'

interface RelatedSessionsModalProps {
    sessionId: string
    workspaces: Workspace[]
    relations: SessionRelation[]
    onClose: () => void
    /** One id: show it as a sidebar click does. Several: side by side in split view. */
    onShowSessions: (sessionIds: string[]) => void
}

/** "Open side by side" puts this session in the first pane, so the others get the rest of the split view. */
const MAX_PICKED = MAX_LINKED_SESSIONS - 1

type RelatedTab = 'tree' | 'recent' | 'all'

/** Only the relation tab exists so far; the others are shown so the dialog's shape can be judged. */
const TABS: Array<{ key: RelatedTab; label: string; ready: boolean }> = [
    { key: 'tree', label: 'Relations', ready: true },
    { key: 'recent', label: 'Recent', ready: false },
    { key: 'all', label: 'All', ready: false }
]

/**
 * The sessions that belong with this one, at a glance: state, last line and
 * memo of each, one click to go there, or several side by side.
 */
export function RelatedSessionsModal({ sessionId, workspaces, relations, onClose, onShowSessions }: RelatedSessionsModalProps) {
    const tree = useMemo(() => sessionTreeFor(relations, sessionId, workspaces), [relations, sessionId, workspaces])
    const entries: RelatedEntry[] = useMemo(
        () => [...tree.descendants, ...tree.ancestors, ...tree.siblings, ...tree.manual],
        [tree]
    )
    const { notice, copy } = useCopyWithNotice()
    const relatedIds = useMemo(() => new Set(entries.map(entry => entry.session.id)), [entries])
    const peeks = useSessionPeeks(entries.map(entry => entry.session.id))
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
    const liveSelection = selected.filter(id => relatedIds.has(id))

    // Take focus from the terminal: keys typed while the dialog is open must not reach the shell.
    useEffect(() => {
        panelRef.current?.focus()
    }, [])

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                onClose()
            }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [onClose])

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

    return (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-20 px-4">
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={onClose} />
            <div
                ref={panelRef}
                tabIndex={-1}
                className="relative w-full max-w-2xl glass-panel rounded-lg shadow-2xl overflow-hidden outline-none"
                data-related-modal={sessionId}
            >
                <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10">
                    <Waypoints size={14} className="text-gray-400" />
                    <span className="text-sm text-white">Related sessions</span>
                    <span className="text-xs text-gray-500 truncate">— {owner.name}</span>
                    <button onClick={onClose} className="ml-auto p-1 hover:bg-white/10 rounded transition-colors" title="Close (Esc)">
                        <X size={14} className="text-gray-400" />
                    </button>
                </div>

                <div className="flex gap-1 px-4 pt-2 border-b border-white/10" role="tablist">
                    {TABS.map(tab => (
                        <button
                            key={tab.key}
                            role="tab"
                            aria-selected={tab.key === 'tree'}
                            disabled={!tab.ready}
                            title={tab.ready ? undefined : 'Coming in a later step'}
                            className={`px-3 py-1.5 text-xs border-b-2 -mb-px transition-colors ${tab.key === 'tree' ? 'border-blue-500 text-white' : 'border-transparent text-gray-600 cursor-not-allowed'}`}
                            data-related-tab={tab.key}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>

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

                {entries.length > 0 && (
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
        </div>
    )
}
