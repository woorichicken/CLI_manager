import { useLayoutEffect, useRef, useState } from 'react'
import { Folder, Search, X } from 'lucide-react'
import type { PhoneSession, PhoneSessionsResponse } from '../../../shared/phone'
import { listLines, searchLines } from './sessionListLines'
import { SessionRow } from './SessionRow'

/**
 * The sessions on the Mac, read only, as one list in the Mac's own order: the sidebar's
 * «All sessions» (List) top to bottom. main orders it with the sidebar's functions, so this
 * only draws it — it never sorts. Like the Mac it marks where each session folder starts and
 * puts a line under the pinned sessions; each row carries its workspace's name. A dot says
 * working (blue) or waiting for you (amber, with the question). A press held on a row renames it
 * (SessionRow, ebf8dec6); no create or delete.
 */

/**
 * Where the list was scrolled, kept across the drawer closing (it unmounts) — b85fc49b: every close
 * put the list back at the top. Module memory: the page's life, like the Mac sidebar's own scroll.
 */
let savedScrollTop = 0

export function SessionList({
    data,
    activeId,
    canRename = false,
    onOpen,
    onRenamed
}: {
    data: PhoneSessionsResponse | null
    activeId: string | null
    /** this device may type (drive): a held press renames */
    canRename?: boolean
    onOpen: (session: PhoneSession) => void
    /** the Mac kept this name — shown at once, before the next list poll */
    onRenamed?: (id: string, name: string) => void
}) {
    const [renamingId, setRenamingId] = useState<string | null>(null)
    const waiting = data?.sessions.filter((s) => s.state === 'waiting').length ?? 0
    // a search over the list (1b92a570): the head's magnifier opens a box; empty box = the whole list
    const [searching, setSearching] = useState(false)
    const [query, setQuery] = useState('')
    const found = data && searching ? searchLines(data, query) : null
    const lines = found ?? (data ? listLines(data) : [])
    const list = useRef<HTMLElement>(null)
    // before paint: the drawer opens where it was left, not at the top and then jumping
    const hasRows = lines.length > 0
    useLayoutEffect(() => {
        if (list.current && hasRows) list.current.scrollTop = savedScrollTop
    }, [hasRows])

    return (
        <nav
            ref={list}
            className="phone-list"
            data-testid="phone-session-list"
            aria-label="Sessions"
            onScroll={(event) => {
                // a search's short result is not where the list was
                if (!found) savedScrollTop = event.currentTarget.scrollTop
            }}
        >
            <div className="phone-list-head">
                <span className="phone-list-title">All sessions</span>
                {data && <span className="phone-group-count">{data.sessions.length}</span>}
                <span className="phone-list-order">Mac order</span>
                {waiting > 0 && <span className="phone-waiting-count" data-testid="phone-waiting-count">{waiting} waiting</span>}
                {data && data.sessions.length > 0 && (
                    <button
                        type="button"
                        className="phone-list-search-toggle"
                        aria-label={searching ? 'Close search' : 'Search sessions'}
                        aria-pressed={searching}
                        data-testid="phone-list-search-toggle"
                        onClick={() => {
                            setSearching((on) => !on)
                            setQuery('')
                        }}
                    >
                        {searching ? <X size={15} /> : <Search size={15} />}
                    </button>
                )}
            </div>
            {searching && (
                <form
                    className="phone-list-search"
                    role="search"
                    onSubmit={(event) => {
                        // Return opens the first match, as the Mac sidebar's search does
                        event.preventDefault()
                        const first = found?.find((line) => line.kind === 'row')
                        if (first?.kind === 'row') onOpen(first.session)
                    }}
                >
                    <Search size={13} aria-hidden="true" />
                    <input
                        // not type=search: its own clear ✕ would sit beside the head's
                        type="text"
                        inputMode="search"
                        // opened by a tap on the magnifier: the keyboard is wanted now
                        autoFocus
                        value={query}
                        placeholder="Session, workspace or folder"
                        aria-label="Search sessions"
                        data-testid="phone-list-search"
                        enterKeyHint="go"
                        autoCapitalize="off"
                        autoCorrect="off"
                        onChange={(event) => setQuery(event.target.value)}
                    />
                </form>
            )}
            {found && found.length === 0 && <div className="phone-empty" data-testid="phone-list-search-empty">No session matches “{query.trim()}”.</div>}
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
                return (
                    <SessionRow
                        key={line.key}
                        session={line.session}
                        active={line.session.id === activeId}
                        renaming={line.session.id === renamingId}
                        canRename={canRename}
                        onOpen={onOpen}
                        onRename={(session) => setRenamingId(session.id)}
                        onRenamed={(session, kept) => {
                            setRenamingId(null)
                            onRenamed?.(session.id, kept)
                        }}
                        onCancelRename={() => setRenamingId(null)}
                    />
                )
            })}
        </nav>
    )
}
