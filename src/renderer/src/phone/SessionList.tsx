import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { Folder, Search, X } from 'lucide-react'
import type { PhoneSession, PhoneSessionsResponse } from '../../../shared/phone'
import { PhoneMemoPanel } from './PhoneMemoPanel'
import { listLines, searchLines, treeLines } from './sessionListLines'
import { SessionRow } from './SessionRow'
import { SessionRowMenu } from './SessionRowMenu'

/**
 * The sessions on the Mac, read only, as one list in the Mac's own order: the sidebar's
 * «All sessions» (List) top to bottom. main orders it with the sidebar's functions, so this
 * only draws it — it never sorts. Like the Mac it marks where each session folder starts and
 * puts a line under the pinned sessions; each row carries its workspace's name. A dot says
 * working (blue) or waiting for you (amber, with the question). A press held on a row renames it
 * (SessionRow, ebf8dec6), and its ⋯ shows the same and the memo (f683eafe); no create or delete.
 * Where the Mac offers its Tree, a List · Tree switch draws the same forest (7c4165af).
 */

/**
 * Where the list was scrolled, kept across the drawer closing (it unmounts) — b85fc49b: every close
 * put the list back at the top. Module memory: the page's life, like the Mac sidebar's own scroll.
 */
let savedScrollTop = 0

/**
 * List or Tree (7c4165af) — this phone's own choice, as the Mac keeps its own (`sidebar-all-sessions-layout`).
 * Storage can throw (a private window): then it is List each time.
 */
type ListLayout = 'list' | 'tree'
const LAYOUT_KEY = 'phone-session-layout'
function readLayout(): ListLayout {
    try {
        return localStorage.getItem(LAYOUT_KEY) === 'tree' ? 'tree' : 'list'
    } catch {
        return 'list'
    }
}
function keepLayout(layout: ListLayout): void {
    try {
        localStorage.setItem(LAYOUT_KEY, layout)
    } catch {
        // not kept: the next visit starts at List
    }
}
/** how far a Tree row moves right per level */
const TREE_INDENT_PX = 14

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
    // the ⋯ menu that is open (f683eafe), and the memo it opened — over the drawer, read-only
    const [menuId, setMenuId] = useState<string | null>(null)
    const [memoId, setMemoId] = useState<string | null>(null)
    const closeMenu = useCallback(() => setMenuId(null), [])
    const [layout, setLayout] = useState<ListLayout>(readLayout)
    // the Mac's «Show Session Tree» off: no tree comes, and the list is List whatever was picked
    const treeShown = layout === 'tree' && !!data?.tree
    const waiting = data?.sessions.filter((s) => s.state === 'waiting').length ?? 0
    // a search over the list (1b92a570): the head's magnifier opens a box; empty box = the whole list
    const [searching, setSearching] = useState(false)
    const [query, setQuery] = useState('')
    const found = data && searching ? searchLines(data, query) : null
    const lines = found ?? (data ? (treeShown ? treeLines(data) : null) ?? listLines(data) : [])
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
                {data?.tree ? (
                    <span className="phone-list-layout" role="group" aria-label="Layout" data-testid="phone-list-layout">
                        {(['list', 'tree'] as const).map((choice) => (
                            <button
                                key={choice}
                                type="button"
                                aria-pressed={(choice === 'tree') === treeShown}
                                data-testid={`phone-layout-${choice}`}
                                onClick={() => {
                                    setLayout(choice)
                                    keepLayout(choice)
                                }}
                            >
                                {choice === 'list' ? 'List' : 'Tree'}
                            </button>
                        ))}
                    </span>
                ) : (
                    <span className="phone-list-order">Mac order</span>
                )}
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
                const renaming = line.session.id === renamingId
                return (
                    <div
                        key={line.key}
                        className="phone-row-wrap"
                        data-tree-depth={line.depth}
                        style={line.depth ? { paddingLeft: line.depth * TREE_INDENT_PX } : undefined}
                    >
                        <SessionRow
                            session={line.session}
                            logo={line.session.templateId ? data?.templateLogos?.[line.session.templateId] : undefined}
                            active={line.session.id === activeId}
                            renaming={renaming}
                            canRename={canRename}
                            onOpen={onOpen}
                            onRename={(session) => setRenamingId(session.id)}
                            onRenamed={(session, kept) => {
                                setRenamingId(null)
                                onRenamed?.(session.id, kept)
                            }}
                            onCancelRename={() => setRenamingId(null)}
                        />
                        {canRename && !renaming && (
                            <SessionRowMenu
                                session={line.session}
                                open={menuId === line.session.id}
                                onToggle={() => setMenuId((open) => (open === line.session.id ? null : line.session.id))}
                                onClose={closeMenu}
                                onRename={() => {
                                    setMenuId(null)
                                    setRenamingId(line.session.id)
                                }}
                                onMemo={() => {
                                    setMenuId(null)
                                    setMemoId(line.session.id)
                                }}
                            />
                        )}
                    </div>
                )
            })}
            {memoId && <PhoneMemoPanel sessionId={memoId} onClose={() => setMemoId(null)} />}
        </nav>
    )
}
