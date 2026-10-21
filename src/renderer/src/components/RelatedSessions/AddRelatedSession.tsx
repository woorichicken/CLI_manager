import { useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import { Workspace } from '../../../../shared/types'
import { addableSessions, isTalkSession } from '../../utils/relatedSessions'

interface AddRelatedSessionProps {
    sessionId: string
    workspaces: Workspace[]
    relatedIds: Set<string>
    onAdd: (sessionId: string) => void
}

/** Picks a session to add by hand: type to filter by session or workspace name. */
export function AddRelatedSession({ sessionId, workspaces, relatedIds, onAdd }: AddRelatedSessionProps) {
    const [query, setQuery] = useState('')
    const candidates = useMemo(
        () => addableSessions(workspaces, sessionId, relatedIds, query),
        [workspaces, sessionId, relatedIds, query]
    )

    return (
        <div className="border-t border-white/10">
            <div className="flex items-center gap-2 px-4 py-2">
                <Search size={12} className="text-gray-500" />
                <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Add a session — type a session or workspace name"
                    className="flex-1 bg-transparent border-none outline-none text-xs text-white placeholder-gray-500"
                    data-related-add-input
                />
            </div>
            <div className="max-h-36 overflow-y-auto pb-1">
                {candidates.length === 0 && (
                    <div className="px-4 py-2 text-xs text-gray-500">
                        {query.trim() ? 'No session matches.' : 'Every other session is already related.'}
                    </div>
                )}
                {candidates.map(({ session, workspace }) => (
                    <button
                        key={session.id}
                        onClick={() => {
                            onAdd(session.id)
                            setQuery('')
                        }}
                        className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-white/5 transition-colors"
                        title="Add to related sessions"
                        data-related-candidate={session.id}
                    >
                        <Plus size={12} className="text-gray-500 shrink-0" />
                        <span className="text-xs text-gray-300 truncate">{session.name}</span>
                        {isTalkSession(session.name) && (
                            <span className="shrink-0 px-1.5 rounded-full bg-violet-500/15 text-[10px] text-violet-300">Talk</span>
                        )}
                        <span className="text-[11px] text-gray-500 truncate">{workspace.name}</span>
                    </button>
                ))}
            </div>
        </div>
    )
}
