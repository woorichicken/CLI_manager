import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { SessionPeek, TerminalSession, Workspace } from '../../../../shared/types'
import { addableSessions } from '../../utils/relatedSessions'
import { RelatedSessionRow } from './RelatedSessionRow'

interface RowHandlers {
    peeks: Map<string, SessionPeek>
    selected: string[]
    selectionFull: boolean
    onToggle: (sessionId: string) => void
    onShow: (sessionId: string) => void
    onCopyId: (sessionId: string) => void
}

type Listed = { session: TerminalSession; workspace: Workspace }

/**
 * The sessions the user looked at last, newest first (rows from
 * `recentSessionRows`). Only for the Related dialog, hence not a shared component.
 */
export function RecentList({ rows, ...handlers }: RowHandlers & { rows: Listed[] }) {
    return (
        <div data-related-recent>
            {rows.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-gray-500" data-related-empty>
                    Sessions you switch to show up here, newest first.
                </div>
            )}
            {rows.map(({ session, workspace }) => (
                <RelatedSessionRow
                    key={session.id}
                    entry={{ session, workspace }}
                    peek={handlers.peeks.get(session.id)}
                    selected={handlers.selected.includes(session.id)}
                    selectionFull={handlers.selectionFull}
                    onToggle={handlers.onToggle}
                    onShow={handlers.onShow}
                    onCopyId={handlers.onCopyId}
                />
            ))}
        </div>
    )
}

/**
 * Recent ids that still exist, in the order given. The ids come from main and can name a
 * session that is gone. The dialog's own session is left out: it is on screen already.
 */
export type ListedSession = Listed

export function recentSessionRows(recentIds: string[], workspaces: Workspace[], ownerId: string): Listed[] {
    const byId = new Map<string, Listed>()
    for (const workspace of workspaces) {
        for (const session of workspace.sessions ?? []) byId.set(session.id, { session, workspace })
    }
    return recentIds.filter(id => id !== ownerId).flatMap(id => byId.get(id) ?? [])
}

/**
 * Every session, by workspace, with a box to narrow it by session or workspace
 * name. Rows show no state: the state needs a poll per session, and this tab
 * can hold all of them.
 */
export function AllList({ workspaces, ownerId, ...handlers }: Omit<RowHandlers, 'peeks'> & {
    workspaces: Workspace[]
    ownerId: string
}) {
    const [query, setQuery] = useState('')
    const groups = useMemo(() => {
        const matches = addableSessions(workspaces, ownerId, new Set(), query)
        const byWorkspace = new Map<string, { workspace: Workspace; sessions: TerminalSession[] }>()
        for (const { session, workspace } of matches) {
            const group = byWorkspace.get(workspace.id) ?? { workspace, sessions: [] }
            group.sessions.push(session)
            byWorkspace.set(workspace.id, group)
        }
        return [...byWorkspace.values()]
    }, [workspaces, ownerId, query])

    return (
        <div data-related-all>
            <div className="flex items-center gap-2 px-4 py-2 border-b border-white/5">
                <Search size={12} className="text-gray-500" />
                <input
                    value={query}
                    onChange={e => setQuery(e.target.value)}
                    placeholder="Filter by session or workspace name"
                    className="flex-1 bg-transparent border-none outline-none text-xs text-white placeholder-gray-500"
                    data-related-search
                />
            </div>
            {groups.length === 0 && (
                <div className="px-4 py-6 text-center text-xs text-gray-500" data-related-empty>
                    {query.trim() ? 'No session matches.' : 'No other sessions.'}
                </div>
            )}
            {groups.map(({ workspace, sessions }) => (
                <div key={workspace.id} data-related-workspace={workspace.id}>
                    <div className="px-4 pt-2 pb-1 text-[11px] uppercase tracking-wide text-gray-500 truncate">{workspace.name}</div>
                    {sessions.map(session => (
                        <RelatedSessionRow
                            key={session.id}
                            entry={{ session, workspace }}
                            peek={undefined}
                            hideState
                            selected={handlers.selected.includes(session.id)}
                            selectionFull={handlers.selectionFull}
                            onToggle={handlers.onToggle}
                            onShow={handlers.onShow}
                            onCopyId={handlers.onCopyId}
                        />
                    ))}
                </div>
            ))}
        </div>
    )
}
