import React, { useRef, useState } from 'react'
import { ChevronDown, ChevronRight, FolderOpen, Folder } from 'lucide-react'
import { SessionFolder } from '../../../../shared/types'
import { groupBySessionFolder, sessionFolderOf, type SessionEntry } from '../../utils/sessionNavigation'
import type { SessionFolderActions } from '../../hooks/useSessionFolders'
import { SidebarSessionList } from './SidebarSessionList'
import { FolderContextMenu } from './ContextMenus'
import { SESSION_DRAG_TYPE, isSessionDrag, useDropHighlight, useSessionDrop } from './sessionDrop'

type SessionListProps = Omit<React.ComponentProps<typeof SidebarSessionList>, 'entries'>

interface SidebarAllSessionsProps {
    /** Every session, already in list order (pinned, then recently viewed). */
    entries: SessionEntry[]
    sessionFolders: SessionFolder[]
    folderActions: SessionFolderActions
    listProps: SessionListProps
    fontSize?: number
    showSessionCount?: boolean
    /** Writes to the clipboard and shows the sidebar's "Copied" notice. */
    onCopy?: (text: string, label: string) => void
    /** «No folder» folded or not (cbc0ee48) — held by the sidebar, whose fold-all button counts it. */
    noFolderExpanded?: boolean
    onToggleNoFolder?: () => void
    /** Right-click "New Session…" on a folder (`null` = the "No folder" row): the sidebar opens New session for it (b9038a0e). */
    onNewSessionIn?: (folderId: string | null) => void
}

/**
 * The All sessions view: session folders first, each holding its sessions in
 * list order, then the sessions in no folder. A session row dropped on a folder
 * heading goes into that folder; dropped on "No folder" it comes out (078ee766).
 * Dropped on another session row it relates the two instead (SessionItem).
 */
export function SidebarAllSessions({ entries, sessionFolders, folderActions, listProps, fontSize = 14, showSessionCount = true, onCopy, noFolderExpanded = true, onToggleNoFolder, onNewSessionIn }: SidebarAllSessionsProps) {
    // folderId null = the "No folder" row's menu, which only starts a session.
    const [menu, setMenu] = useState<{ x: number; y: number; folderId: string | null } | null>(null)
    const [renamingId, setRenamingId] = useState<string | null>(null)
    // Esc unmounts the input, which may blur it: that blur must not save what Esc threw away.
    const renameCancelledRef = useRef(false)
    const folderIds = new Set(sessionFolders.map(f => f.id))
    // The same grouping the phone's list flattens: what it shows top to bottom is this.
    const { folders: folderRows, unfiled } = groupBySessionFolder(entries, sessionFolders)
    // The folder's sessions in the order the list shows them, as Copy IDs does.
    const menuFolder = menu ? sessionFolders.find(f => f.id === menu.folderId) : undefined
    const menuSessionIds = menu
        ? entries.filter(entry => sessionFolderOf(entry, folderIds) === menu.folderId).map(entry => entry.session.id)
        : []

    return (
        <>
            {folderRows.map(({ folder, rows }) => {
                return (
                    <div key={folder.id} data-session-folder={folder.id}>
                        <FolderDropRow
                            folderId={folder.id}
                            entries={entries}
                            folderIds={folderIds}
                            onDropSession={id => void folderActions.moveSession(id, folder.id)}
                            className="group/folder flex items-center gap-2 py-1 px-2 rounded hover:bg-white/5 cursor-pointer transition-colors"
                            testId={`session-folder-header-${folder.id}`}
                            onClick={() => { if (renamingId !== folder.id) void folderActions.toggleExpanded(folder.id) }}
                            onContextMenu={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                setMenu({ x: e.clientX, y: e.clientY, folderId: folder.id })
                            }}
                        >
                            {folder.isExpanded
                                ? <ChevronDown size={14} className="text-gray-400 shrink-0" />
                                : <ChevronRight size={14} className="text-gray-400 shrink-0" />}
                            {folder.isExpanded
                                ? <FolderOpen size={14} className="text-sky-400/70 shrink-0" />
                                : <Folder size={14} className="text-sky-400/70 shrink-0" />}
                            {renamingId === folder.id ? (
                                <input
                                    autoFocus
                                    data-testid="session-folder-rename"
                                    className="bg-transparent border border-white/20 rounded px-1 text-xs outline-none focus:border-blue-500 w-full min-w-0"
                                    defaultValue={folder.name}
                                    style={{ fontSize: `${fontSize}px` }}
                                    onClick={(e) => e.stopPropagation()}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                        if (e.key === 'Escape') {
                                            renameCancelledRef.current = true
                                            setRenamingId(null)
                                        }
                                    }}
                                    onBlur={(e) => {
                                        if (!renameCancelledRef.current) void folderActions.rename(folder.id, e.target.value)
                                        renameCancelledRef.current = false
                                        setRenamingId(null)
                                    }}
                                />
                            ) : (
                                <span className="text-sky-100/80 font-medium truncate min-w-0" style={{ fontSize: `${fontSize}px` }}>{folder.name}</span>
                            )}
                            {showSessionCount && (
                                <span className="text-[10px] text-gray-500 shrink-0" data-session-folder-count={folder.id}>({rows.length})</span>
                            )}
                        </FolderDropRow>
                        {folder.isExpanded && (
                            <div data-session-folder-body={folder.id} className="ml-3 pl-2 border-l border-white/5">
                                {rows.length > 0
                                    ? <SidebarSessionList entries={rows} dividePinned {...listProps} />
                                    : <div className="px-1.5 py-1 text-[11px] text-gray-600">Drag sessions here</div>}
                            </div>
                        )}
                    </div>
                )
            })}

            {/* «No folder» folds like a folder heading (cbc0ee48). Folded, it stays a drop target: a session
                dropped on it leaves its folder. Without folders there is no heading — the list is all of it. */}
            {sessionFolders.length > 0 && (
                <FolderDropRow
                    folderId={null}
                    entries={entries}
                    folderIds={folderIds}
                    onDropSession={id => void folderActions.moveSession(id, null)}
                    className="mt-2 mb-0.5 flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-white/5 cursor-pointer transition-colors text-[10px] uppercase tracking-wider text-gray-500"
                    testId="session-folder-none"
                    state={noFolderExpanded ? 'expanded' : 'collapsed'}
                    onClick={onToggleNoFolder}
                    onContextMenu={onNewSessionIn ? (e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        setMenu({ x: e.clientX, y: e.clientY, folderId: null })
                    } : undefined}
                >
                    {noFolderExpanded
                        ? <ChevronDown size={12} className="text-gray-500 shrink-0" />
                        : <ChevronRight size={12} className="text-gray-500 shrink-0" />}
                    <span>No folder</span>
                    {showSessionCount && (
                        <span className="normal-case tracking-normal text-gray-500 shrink-0" data-session-folder-count="none">({unfiled.length})</span>
                    )}
                </FolderDropRow>
            )}
            {unfiled.length > 0 && (sessionFolders.length === 0 || noFolderExpanded) && (
                <div data-session-folder-none-body>
                    <SidebarSessionList entries={unfiled} dividePinned {...listProps} />
                </div>
            )}

            {menu && menu.folderId === null && onNewSessionIn && (
                <FolderContextMenu
                    x={menu.x}
                    y={menu.y}
                    onClose={() => setMenu(null)}
                    onNewSession={() => onNewSessionIn(null)}
                />
            )}
            {menu && menu.folderId !== null && (
                <FolderContextMenu
                    x={menu.x}
                    y={menu.y}
                    onNewSession={onNewSessionIn ? () => onNewSessionIn(menu.folderId) : undefined}
                    onRename={() => {
                        // Esc may have left the flag set: a removed input gets no blur to clear it.
                        renameCancelledRef.current = false
                        setRenamingId(menu.folderId)
                        setMenu(null)
                    }}
                    onDelete={() => {
                        // Deleting the folder never closes a session: they go back to "No folder".
                        if (menu.folderId) void folderActions.remove(menu.folderId)
                        setMenu(null)
                    }}
                    onClose={() => setMenu(null)}
                    onCopyName={onCopy && menuFolder ? () => onCopy(menuFolder.name, 'folder name') : undefined}
                    onCopySessionIds={onCopy ? () => onCopy(menuSessionIds.join('\n'), `${menuSessionIds.length} session ID${menuSessionIds.length === 1 ? '' : 's'}`) : undefined}
                    sessionCount={menuSessionIds.length}
                />
            )}
        </>
    )
}

interface FolderDropRowProps {
    /** The folder a drop here files the session in; `null` = no folder. */
    folderId: string | null
    entries: SessionEntry[]
    folderIds: Set<string>
    onDropSession: (sessionId: string) => void
    className: string
    testId: string
    /** Folded or not, for a heading that folds. */
    state?: 'expanded' | 'collapsed'
    onClick?: () => void
    onContextMenu?: (e: React.MouseEvent) => void
    children: React.ReactNode
}

/** A heading that files a dragged session. It does not light up for a session already filed there. */
function FolderDropRow({ folderId, entries, folderIds, onDropSession, className, testId, state, onClick, onContextMenu, children }: FolderDropRowProps) {
    const drop = useSessionDrop()
    const dragged = drop?.draggingId ? entries.find(entry => entry.session.id === drop.draggingId) : undefined
    const takesDrop = !!dragged && sessionFolderOf(dragged, folderIds) !== folderId
    const highlight = useDropHighlight(takesDrop)
    // dragenter and dragover both accept: the browser fires dragover on a timer, and a drop
    // goes only to the element that accepted the last one of them.
    const accept = (e: React.DragEvent): void => {
        if (!takesDrop || !isSessionDrag(e)) return
        e.preventDefault()
        highlight.enter()
    }

    return (
        <div
            data-testid={testId}
            data-drop-state={highlight.over ? 'over' : 'idle'}
            data-state={state}
            className={`${className} ${highlight.over ? 'ring-1 ring-inset ring-sky-400/70 bg-sky-500/10' : ''}`}
            onClick={onClick}
            onContextMenu={onContextMenu}
            onDragEnter={accept}
            onDragOver={accept}
            onDragLeave={highlight.leave}
            onDrop={(e) => {
                if (!takesDrop || !isSessionDrag(e)) return
                e.preventDefault()
                highlight.clear()
                onDropSession(e.dataTransfer.getData(SESSION_DRAG_TYPE) || dragged!.session.id)
            }}
        >
            {children}
        </div>
    )
}
