import { useEffect, useMemo, useRef, useState } from 'react'
import { Columns2, Waypoints, X } from 'lucide-react'
import { SessionRelation, Workspace } from '../../../../shared/types'
import { RelatedEntry, relatedSessionsFor } from '../../utils/relatedSessions'
import { MAX_LINKED_SESSIONS } from '../../utils/sessionLink'
import { useSessionPeeks } from '../../hooks/useSessionPeeks'
import { RelatedSessionRow } from './RelatedSessionRow'
import { AddRelatedSession } from './AddRelatedSession'

interface RelatedSessionsModalProps {
    sessionId: string
    workspaces: Workspace[]
    relations: SessionRelation[]
    onClose: () => void
    /** One id: show it as a sidebar click does. Several: side by side in split view. */
    onShowSessions: (sessionIds: string[]) => void
}

const GROUPS: Array<{ key: 'fromHere' | 'toHere' | 'manual'; title: string; hint: string }> = [
    { key: 'fromHere', title: 'Opened from this session', hint: 'Its agent opened them, or started working in them, through the Control API.' },
    { key: 'toHere', title: 'Opened this session', hint: 'An agent there opened this session, or started working in it.' },
    { key: 'manual', title: 'Added by hand', hint: 'Added in this dialog, here or in the other session.' }
]

/**
 * The sessions that belong with this one, at a glance: state, last line and
 * memo of each, one click to go there, or several side by side.
 */
export function RelatedSessionsModal({ sessionId, workspaces, relations, onClose, onShowSessions }: RelatedSessionsModalProps) {
    const groups = useMemo(() => relatedSessionsFor(relations, sessionId, workspaces), [relations, sessionId, workspaces])
    const entries: RelatedEntry[] = useMemo(() => [...groups.fromHere, ...groups.toHere, ...groups.manual], [groups])
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
        setSelected(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id].slice(0, MAX_LINKED_SESSIONS))
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

                <div className="max-h-[50vh] overflow-y-auto py-1">
                    {groups.total === 0 && (
                        <div className="px-4 py-6 text-center text-xs text-gray-500" data-related-empty>
                            No related sessions yet. Sessions an agent here opens or works in through the
                            Control API show up on their own; add one by hand below.
                        </div>
                    )}
                    {GROUPS.map(group => groups[group.key].length > 0 && (
                        <div key={group.key} data-related-group={group.key}>
                            <div className="px-4 pt-2 pb-1 text-[11px] uppercase tracking-wide text-gray-500" title={group.hint}>
                                {group.title}
                            </div>
                            {groups[group.key].map(entry => (
                                <RelatedSessionRow
                                    key={entry.session.id}
                                    entry={entry}
                                    peek={peeks.get(entry.session.id)}
                                    selected={liveSelection.includes(entry.session.id)}
                                    selectionFull={liveSelection.length >= MAX_LINKED_SESSIONS}
                                    onToggle={toggle}
                                    onShow={id => show([id])}
                                    onRemove={id => void window.api.removeSessionRelation(sessionId, id)}
                                />
                            ))}
                        </div>
                    ))}
                </div>

                {groups.total > 0 && (
                    <div className="flex items-center gap-2 px-4 py-2 border-t border-white/10">
                        <span className="text-[11px] text-gray-500">
                            {liveSelection.length === 0
                                ? `Click a session to go there, or tick up to ${MAX_LINKED_SESSIONS} to see them side by side.`
                                : `${liveSelection.length} selected`}
                        </span>
                        <button
                            onClick={() => show(liveSelection)}
                            disabled={liveSelection.length < 2}
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
            </div>
        </div>
    )
}
