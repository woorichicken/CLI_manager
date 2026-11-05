import { Folder, MessageSquareText, Pin, TerminalSquare } from 'lucide-react'
import type { PhoneSession, PhoneSessionsResponse } from '../../../shared/phone'
import { listLines } from './sessionListLines'

/**
 * The sessions on the Mac, read only, as one list in the Mac's own order: the sidebar's
 * «All sessions» (List) top to bottom. main orders it with the sidebar's functions, so this
 * only draws it — it never sorts. Like the Mac it marks where each session folder starts and
 * puts a line under the pinned sessions; each row carries its workspace's name. A dot says
 * working (blue) or waiting for you (amber, with the question). No create, delete or rename.
 */

const STATE_TEXT: Partial<Record<PhoneSession['state'], string>> = {
    working: 'Working…',
    stopped: 'Not running',
    exited: 'Exited'
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
    const waiting = data?.sessions.filter((s) => s.state === 'waiting').length ?? 0
    const lines = data ? listLines(data) : []

    return (
        <nav className="phone-list" data-testid="phone-session-list" aria-label="Sessions">
            <div className="phone-list-head">
                <span className="phone-list-title">All sessions</span>
                {data && <span className="phone-group-count">{data.sessions.length}</span>}
                <span className="phone-list-order">Mac order</span>
                {waiting > 0 && <span className="phone-waiting-count" data-testid="phone-waiting-count">{waiting} waiting</span>}
            </div>
            {!data && <div className="phone-empty">Loading sessions…</div>}
            {data && data.sessions.length === 0 && <div className="phone-empty">No sessions on the Mac.</div>}
            {lines.map((line) => {
                if (line.kind === 'folder') {
                    return (
                        <div key={line.key} className="phone-list-folder" data-testid="phone-list-folder" data-folder-id={line.folderId ?? ''}>
                            {line.folderId && <Folder size={12} />}
                            <span>{line.title}</span>
                        </div>
                    )
                }
                if (line.kind === 'divider') return <div key={line.key} role="separator" className="phone-list-divider" data-testid="phone-pinned-divider" />
                const session = line.session
                const stateText = STATE_TEXT[session.state]
                return (
                    <button
                            key={line.key}
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
                                <span className="phone-row-meta">
                                    <span className="phone-row-workspace" data-testid="phone-row-workspace">{session.workspaceName}</span>
                                    {stateText && <span className="phone-row-sub"> · {stateText}</span>}
                                </span>
                                {session.state === 'waiting' && (
                                    <span className="phone-row-question" data-testid="phone-row-question">{session.question ?? 'Waiting for you'}</span>
                                )}
                            </span>
                        </button>
                )
            })}
        </nav>
    )
}
