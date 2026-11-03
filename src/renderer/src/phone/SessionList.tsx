import { useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderTree, GitBranch, MessageSquareText, Pin, TerminalSquare } from 'lucide-react'
import type { PhoneSession, PhoneSessionsResponse } from '../../../shared/phone'

/**
 * The sessions on the Mac, read only: grouped as the sidebar groups them — by workspace
 * (inside its sidebar folder) or by All sessions folder. A dot says working (blue) or
 * waiting for you (amber, with the question). No create, delete or rename here.
 */

type Grouping = 'workspaces' | 'folders'

interface Group {
    id: string
    title: string
    subtitle?: string
    icon: 'folder' | 'workspace' | 'worktree'
    sessions: PhoneSession[]
}

const GROUPING_KEY = 'phone-session-grouping'

function readGrouping(): Grouping {
    try {
        return window.localStorage.getItem(GROUPING_KEY) === 'folders' ? 'folders' : 'workspaces'
    } catch {
        return 'workspaces'
    }
}

export function groupSessions(data: PhoneSessionsResponse, grouping: Grouping): Group[] {
    const byWorkspace = new Map<string, PhoneSession[]>()
    for (const session of data.sessions) {
        const list = byWorkspace.get(session.workspaceId) ?? []
        list.push(session)
        byWorkspace.set(session.workspaceId, list)
    }
    if (grouping === 'folders') {
        const groups: Group[] = data.sessionFolders.map((folder) => ({
            id: `sf-${folder.id}`,
            title: folder.name,
            icon: 'folder',
            sessions: data.sessions.filter((s) => s.sessionFolderId === folder.id)
        }))
        const known = new Set(data.sessionFolders.map((f) => f.id))
        groups.push({ id: 'sf-none', title: 'No folder', icon: 'folder', sessions: data.sessions.filter((s) => !s.sessionFolderId || !known.has(s.sessionFolderId)) })
        return groups.filter((g) => g.sessions.length > 0)
    }
    const folderName = new Map(data.folders.map((f) => [f.id, f.name]))
    return data.workspaces
        .filter((w) => (byWorkspace.get(w.id) ?? []).length > 0)
        .map((w) => ({
            id: `ws-${w.id}`,
            title: w.name,
            subtitle: [w.folderId ? folderName.get(w.folderId) : undefined, w.path].filter(Boolean).join(' · '),
            icon: w.isWorktree ? 'worktree' : 'workspace',
            sessions: [...(byWorkspace.get(w.id) ?? [])].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned))
        }))
}

export function SessionList({
    data,
    activeId,
    onOpen
}: {
    data: PhoneSessionsResponse | null
    activeId: string | null
    onOpen: (session: PhoneSession) => void
}) {
    const [grouping, setGrouping] = useState<Grouping>(readGrouping)
    const [closed, setClosed] = useState<Set<string>>(new Set())
    const groups = useMemo(() => (data ? groupSessions(data, grouping) : []), [data, grouping])
    const waiting = data?.sessions.filter((s) => s.state === 'waiting').length ?? 0

    const choose = (next: Grouping): void => {
        setGrouping(next)
        try {
            window.localStorage.setItem(GROUPING_KEY, next)
        } catch {
            // the choice just is not remembered
        }
    }

    return (
        <nav className="phone-list" data-testid="phone-session-list" aria-label="Sessions">
            <div className="phone-list-head">
                <div className="phone-seg" role="group" aria-label="Group by">
                    <button type="button" aria-pressed={grouping === 'workspaces'} data-testid="phone-group-workspaces" onClick={() => choose('workspaces')}>
                        <FolderTree size={13} /> Workspaces
                    </button>
                    <button type="button" aria-pressed={grouping === 'folders'} data-testid="phone-group-folders" onClick={() => choose('folders')}>
                        <Folder size={13} /> Folders
                    </button>
                </div>
                {waiting > 0 && <span className="phone-waiting-count" data-testid="phone-waiting-count">{waiting} waiting</span>}
            </div>
            {!data && <div className="phone-empty">Loading sessions…</div>}
            {data && groups.length === 0 && <div className="phone-empty">No sessions on the Mac.</div>}
            {groups.map((group) => {
                const isClosed = closed.has(group.id)
                return (
                    <section key={group.id} className="phone-group" data-testid="phone-group" data-group-title={group.title}>
                        <button
                            type="button"
                            className="phone-group-head"
                            onClick={() => setClosed((prev) => {
                                const next = new Set(prev)
                                if (next.has(group.id)) next.delete(group.id)
                                else next.add(group.id)
                                return next
                            })}
                        >
                            {isClosed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                            {group.icon === 'worktree' ? <GitBranch size={14} /> : <Folder size={14} />}
                            <span className="phone-group-title">{group.title}</span>
                            <span className="phone-group-count">{group.sessions.length}</span>
                        </button>
                        {group.subtitle && !isClosed && <div className="phone-group-sub">{group.subtitle}</div>}
                        {!isClosed && group.sessions.map((session) => (
                            <button
                                key={session.id}
                                type="button"
                                className="phone-row"
                                data-testid="phone-session-row"
                                data-session-id={session.id}
                                data-state={session.state}
                                aria-current={session.id === activeId ? 'true' : undefined}
                                onClick={() => onOpen(session)}
                            >
                                <span className={`phone-dot phone-dot-${session.state}`} aria-hidden="true" />
                                {session.agent ? <MessageSquareText size={14} className="phone-row-icon" /> : <TerminalSquare size={14} className="phone-row-icon" />}
                                <span className="phone-row-text">
                                    <span className="phone-row-name">
                                        {session.pinned && <Pin size={11} className="phone-row-pin" />}
                                        {session.name}
                                    </span>
                                    {session.state === 'waiting' && (
                                        <span className="phone-row-question" data-testid="phone-row-question">{session.question ?? 'Waiting for you'}</span>
                                    )}
                                    {session.state === 'working' && <span className="phone-row-sub">Working…</span>}
                                    {session.state === 'stopped' && <span className="phone-row-sub">Not running</span>}
                                    {session.state === 'exited' && <span className="phone-row-sub">Exited</span>}
                                </span>
                            </button>
                        ))}
                    </section>
                )
            })}
        </nav>
    )
}
