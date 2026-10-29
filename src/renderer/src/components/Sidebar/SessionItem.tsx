import React, { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Terminal, Trash2, GripVertical, Bot, Crown, Pin, ChevronDown, ChevronRight } from 'lucide-react'
import clsx from 'clsx'
import { Reorder, useDragControls, AnimatePresence, motion } from 'framer-motion'
import { TerminalSession, Workspace, SessionStatus } from '../../../../shared/types'
import { useControlApiMasters } from '../../hooks/useControlApiMasters'
import { useSessionScreenStatus } from '../../hooks/useSessionScreenStatus'
import { InboxDot } from '../Inbox/InboxDot'
import { SESSION_DRAG_TYPE, isSessionDrag, useDropHighlight, useSessionDrop } from './sessionDrop'
import type { TreeGuide } from '../../utils/relatedSessions'
import type { SessionSelection } from './SessionSelectionBar'

// Session status colors (claude-squad 방식)
const SESSION_STATUS_COLORS: Record<SessionStatus, string> = {
    idle: 'bg-gray-500',
    running: 'bg-blue-500 animate-pulse',
    ready: 'bg-amber-500',
    error: 'bg-red-500'
}

const SESSION_STATUS_TITLES: Record<SessionStatus, string> = {
    idle: 'Idle',
    running: 'Running (output being generated)',
    ready: 'Ready (waiting for input)',
    error: 'Error occurred'
}

// "Blocked on a human" is a different situation from "finished and quiet", and
// it is the one worth interrupting the user for. Official hooks can tell the
// two apart (PermissionRequest / Notification); the screen heuristic cannot.
const AWAITING_INPUT_COLOR = 'bg-amber-400 animate-pulse ring-2 ring-amber-400/30'

// Dots read from the screen in main (Settings > General "Show Session Status").
// No pulse on "working": dozens of rows animating at once is noise, and the
// dot itself already says the agent is mid-turn.
const SCREEN_STATUS_COLORS = {
    working: 'bg-blue-500',
    waiting: 'bg-amber-400 ring-2 ring-amber-400/30'
} as const

// Sessions an AI drives through the Control API are green instead of blue, so
// the user can tell at a glance which terminals something else may type into.
// An orchestrator — the session whose agent opened other sessions — is rose,
// so the one directing the others stands out from the ones being directed.
// Priority: master > ai > user.
type SessionRole = 'master' | 'ai' | 'user'

const ROW_CLASSES: Record<SessionRole, { active: string; idle: string }> = {
    master: {
        active: 'bg-rose-500/20 text-rose-200',
        idle: 'text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200'
    },
    user: {
        active: 'bg-blue-500/20 text-blue-200',
        idle: 'text-gray-400 hover:bg-white/5 hover:text-gray-300'
    },
    ai: {
        active: 'bg-emerald-500/20 text-emerald-200',
        idle: 'text-emerald-300/80 hover:bg-emerald-500/10 hover:text-emerald-200'
    }
}

// Hover timing constants
const HOVER_DELAY_MS = 300     // Delay before showing preview
const HOVER_LINGER_MS = 400    // Keep preview visible after mouse leaves

interface SessionItemProps {
    session: TerminalSession
    /**
     * All sessions view only: the row icon turns into a check box on hover (on every
     * row once something is picked). Ticking it picks the row without opening it.
     */
    selection?: SessionSelection
    workspace: Workspace
    isActive: boolean
    sessionStatus?: SessionStatus
    /** Agent is blocked on a human (permission prompt / idle nudge). */
    awaitingInput?: boolean
    isClaudeCodeSession?: boolean
    showStatusInSidebar?: boolean
    fontSize?: number  // Sidebar font size
    terminalPreview?: {
        enabled: boolean
        lineCount: number
    }
    onSelect: (workspace: Workspace, session: TerminalSession) => void
    onRemove: (workspaceId: string, sessionId: string, skipConfirm?: boolean) => void
    onRename: (workspaceId: string, sessionId: string, newName: string) => void
    isRenaming?: boolean
    onContextMenu: (e: React.MouseEvent, workspaceId: string, sessionId: string) => void
    onRenameCancel: () => void
    // Split view props
    isInSplit?: boolean
    onDragStartSession?: (sessionId: string) => void
    onDragEndSession?: () => void
    /** Dimmed text after the name — the "All sessions" list shows which workspace a row belongs to. */
    workspaceLabel?: string
    /** Reordering means nothing in a flat list that mixes workspaces. */
    hideDragHandle?: boolean
    /** Cut a long `workspaceLabel` at the front, so a path keeps its last folder in view. */
    workspaceLabelFromEnd?: boolean
    /** Levels below the tree root in the All sessions tree; drawn as indent. */
    treeDepth?: number
    /**
     * A Tree row's fold button (report dca55fd6), drawn ahead of the icon. `null` for a tree row
     * with nothing under it — a blank of the button's width, so the icons stay in line; left out
     * everywhere else.
     */
    treeBranch?: TreeBranch | null
    /** A Tree row's guide lines — ├ │ └ joining it to the rows above and below (report a35f1aa1). */
    treeGuide?: TreeGuide
}

export interface TreeBranch {
    collapsed: boolean
    /** Every session under this row, at any depth. */
    hiddenCount: number
    /** The active session is in the folded part: this row stands in for it. */
    holdsActive: boolean
    onToggle: () => void
}

// Indent per tree level in the All sessions tree (px). Small: a deep row still needs room for its name.
const TREE_INDENT_PX = 10
// A row's own left padding (px-1.5) and the fold button's width (w-3) — where a tree row's guide lines go.
const TREE_ROW_PAD_PX = 6
const TREE_SLOT_PX = 12
// The space between Tree rows (`space-y-0.5` in SidebarSessionTree): a line that runs on crosses it.
const TREE_ROW_GAP_PX = 2
// The fold button's chevron is 12px tall; a line down to the children starts just under it.
const TREE_CHEVRON_HALF_PX = 6
// A path label gets onto the name's line only with room for about its last folder (in `ch`, capped).
const PATH_LABEL_MIN_CH = 16
// A tree row's name is cut in the middle: this many last characters always stay.
const NAME_TAIL_CHARS = 12

/**
 * A tree row's name and path. The path is cut at the front and yields to the name: it takes only the
 * room the name leaves, down to about its last folder, and below that it wraps onto a clipped second
 * line — hidden — so the name gets the whole width. A name that still does not fit is cut in the
 * middle, keeping its end: sessions named alike differ there, not in the path.
 */
function NameWithPath({ name, path, fontSize }: { name: string; path: string; fontSize: number }) {
    const lastFolder = path.split(/[\\/]/).filter(Boolean).pop() ?? path
    const lineHeight = Math.round(fontSize * 1.5)
    const tailLength = Math.min(NAME_TAIL_CHARS, Math.floor(name.length / 2))
    return (
        <span
            data-testid="session-name-with-path"
            className="flex flex-wrap items-baseline gap-x-1.5 flex-1 min-w-0 overflow-hidden"
            style={{ height: lineHeight, lineHeight: `${lineHeight}px` }}
            title={`${name}\n${path}`}
        >
            {/* Cut in the middle: the end is where batch names differ ("…CLI-Manager api" / "…CLI-Manager ui"). */}
            <span data-testid="session-name" className="flex min-w-0 max-w-full" style={{ fontSize: `${fontSize}px` }}>
                <span className="truncate min-w-0" style={{ whiteSpace: 'pre' }}>{name.slice(0, name.length - tailLength)}</span>
                <span className="shrink-0" style={{ whiteSpace: 'pre' }}>{name.slice(name.length - tailLength)}</span>
            </span>
            <span
                data-testid="session-workspace-label"
                // rtl box cuts at the front; the bdi keeps the text itself left-to-right.
                className="min-w-0 truncate text-[10px] text-gray-500 text-left [direction:rtl]"
                style={{ flex: `1 1000 ${Math.min(lastFolder.length + 2, PATH_LABEL_MIN_CH)}ch` }}
            >
                <bdi dir="ltr">{path}</bdi>
            </span>
        </span>
    )
}

/**
 * The ├ │ └ of a Tree row, drawn over its left padding. A level's line sits under the fold button
 * of the row it hangs from, so a parent, its children and their siblings read as one connected
 * list. A line that runs on reaches through the gap into the next row, where that row's own
 * piece of it starts at its top.
 */
function TreeGuideLines({ depth, guide, leaf }: { depth: number; guide: TreeGuide; leaf: boolean }) {
    const lineX = (level: number): number => TREE_ROW_PAD_PX + (level - 1) * TREE_INDENT_PX + TREE_SLOT_PX / 2
    const slotStart = TREE_ROW_PAD_PX + depth * TREE_INDENT_PX
    // A leaf's arm crosses its empty slot toward the icon; a parent's stops at its fold button.
    const armEnd = leaf ? slotStart + TREE_SLOT_PX - 2 : slotStart + 2
    const vertical = 'pointer-events-none absolute w-px bg-gray-600'
    return (
        <>
            {guide.through.map(level => (
                <span key={level} aria-hidden data-tree-line="v" className={vertical} style={{ left: lineX(level), top: 0, bottom: -TREE_ROW_GAP_PX }} />
            ))}
            {depth > 0 && (
                <>
                    {/* ├ runs on to the next sibling, └ stops at the arm. */}
                    <span
                        aria-hidden
                        data-tree-line="v"
                        className={vertical}
                        style={{ left: lineX(depth), top: 0, bottom: guide.continues ? -TREE_ROW_GAP_PX : 'calc(50% - 0.5px)' }}
                    />
                    <span
                        aria-hidden
                        data-tree-line="arm"
                        className="pointer-events-none absolute h-px bg-gray-600"
                        style={{ left: lineX(depth), top: 'calc(50% - 0.5px)', width: armEnd - lineX(depth) }}
                    />
                </>
            )}
            {guide.opensDown && (
                <span
                    aria-hidden
                    data-tree-line="down"
                    className={vertical}
                    style={{ left: lineX(depth + 1), top: `calc(50% + ${TREE_CHEVRON_HALF_PX}px)`, bottom: -TREE_ROW_GAP_PX }}
                />
            )}
        </>
    )
}

/**
 * 터미널 세션 항목 컴포넌트
 * 세션 선택, 알림 표시, 삭제 기능 제공
 * 드래그 앤 드롭으로 같은 워크스페이스 내에서 순서 변경 가능
 */
export function SessionItem({
    session,
    selection,
    workspace,
    isActive,
    sessionStatus,
    awaitingInput,
    isClaudeCodeSession,
    showStatusInSidebar = true,
    fontSize = 14,
    terminalPreview,
    onSelect,
    onRemove,
    onRename,
    isRenaming,
    onContextMenu,
    onRenameCancel,
    isInSplit,
    onDragStartSession,
    onDragEndSession,
    workspaceLabel,
    hideDragHandle = false,
    workspaceLabelFromEnd = false,
    treeDepth = 0,
    treeBranch,
    treeGuide
}: SessionItemProps) {
    const [tempName, setTempName] = useState(session.name)
    const [previewLines, setPreviewLines] = useState<string[] | null>(null)
    const [showPreview, setShowPreview] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const lingerTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const itemRef = useRef<HTMLDivElement>(null)
    const dragControls = useDragControls()
    const orchestrator = useControlApiMasters().masters[session.id]
    const screenStatus = useSessionScreenStatus(session.id)
    const role: SessionRole = orchestrator ? 'master' : session.aiControl ? 'ai' : 'user'
    const roleIcon = orchestrator ? (
        <span
            className="shrink-0 flex"
            data-master-icon
            title={`Master session — opened ${orchestrator.openedCount} AI session${orchestrator.openedCount === 1 ? '' : 's'}`}
        >
            <Crown size={14} className="text-rose-400" />
        </span>
    ) : session.aiControl ? (
        <span
            className="shrink-0 flex"
            title={`Driven by AI (${session.aiControl.client}) — right-click → Disconnect AI to take it back`}
        >
            <Bot size={14} className="text-emerald-400" />
        </span>
    ) : (
        <Terminal size={14} className="shrink-0" />
    )
    const rowClasses = ROW_CLASSES[role]
    // Another session dropped on this row joins its Related sessions (report 269168e4).
    const drop = useSessionDrop()
    const takesDrop = !!drop?.draggingId && drop.draggingId !== session.id
    const relateTarget = useDropHighlight(takesDrop)
    // dragenter and dragover both accept: the browser fires dragover on a timer, and a drop
    // goes only to the element that accepted the last one of them.
    const acceptRelate = (e: React.DragEvent): void => {
        if (!takesDrop || !isSessionDrag(e)) return
        e.preventDefault()
        e.stopPropagation()
        relateTarget.enter()
    }

    React.useEffect(() => {
        if (isRenaming && inputRef.current) {
            inputRef.current.focus()
            inputRef.current.select()
        }
    }, [isRenaming])

    // Cleanup timers on unmount
    React.useEffect(() => {
        return () => {
            if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current)
            if (lingerTimeoutRef.current) clearTimeout(lingerTimeoutRef.current)
        }
    }, [])

    // Handle mouse enter - start hover timer
    const handleMouseEnter = useCallback(() => {
        // Don't show preview for active session or if disabled
        // Default to disabled (false) if terminalPreview is undefined
        if (isActive || !(terminalPreview?.enabled ?? false)) return

        // Clear any existing linger timeout
        if (lingerTimeoutRef.current) {
            clearTimeout(lingerTimeoutRef.current)
            lingerTimeoutRef.current = null
        }

        // If preview is already showing, keep it
        if (showPreview) return

        // Start hover delay timer
        hoverTimeoutRef.current = setTimeout(async () => {
            try {
                const lines = await window.api.getTerminalPreview(
                    session.id,
                    terminalPreview?.lineCount ?? 5
                )
                if (lines && lines.length > 0) {
                    setPreviewLines(lines)
                    setShowPreview(true)
                }
            } catch (e) {
                console.error('Failed to get terminal preview:', e)
            }
        }, HOVER_DELAY_MS)
    }, [isActive, terminalPreview, session.id, showPreview])

    // Handle mouse leave - start linger timer
    const handleMouseLeave = useCallback(() => {
        // Clear hover timer if still waiting
        if (hoverTimeoutRef.current) {
            clearTimeout(hoverTimeoutRef.current)
            hoverTimeoutRef.current = null
        }

        // Start linger timer to keep preview visible briefly
        if (showPreview) {
            lingerTimeoutRef.current = setTimeout(() => {
                setShowPreview(false)
                setPreviewLines(null)
            }, HOVER_LINGER_MS)
        }
    }, [showPreview])

    const handleRenameSubmit = () => {
        if (tempName.trim() && tempName !== session.name) {
            onRename(workspace.id, session.id, tempName.trim())
        } else {
            setTempName(session.name)
            onRenameCancel()
        }
    }

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter') {
            handleRenameSubmit()
            // Focus terminal after rename
            setTimeout(() => {
                const xtermTextarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
                xtermTextarea?.focus()
            }, 50)
        } else if (e.key === 'Escape') {
            setTempName(session.name)
            onRenameCancel()
            // Focus terminal after cancel
            setTimeout(() => {
                const xtermTextarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement
                xtermTextarea?.focus()
            }, 50)
        }
    }

    // Session status indicator for Claude Code sessions
    const getSessionStatusBadge = () => {
        // Don't show for active session (user is already looking at it)
        if (isActive) return null
        // The screen-read dots replace the older badges while that setting is on.
        if (screenStatus.enabled) {
            const status = screenStatus.status
            if (!status || status.state === 'idle') return null
            return (
                <div
                    data-session-status={status.state}
                    className={`w-2 h-2 rounded-full shrink-0 ${SCREEN_STATUS_COLORS[status.state]}`}
                    title={status.state === 'waiting'
                        ? `Waiting for you${status.question ? ` — ${status.question}` : ''}`
                        : 'Working'}
                />
            )
        }
        // Only show if enabled and it's a Claude Code session
        if (!showStatusInSidebar || !isClaudeCodeSession || !sessionStatus) return null
        // Don't show idle status to reduce visual noise
        if (sessionStatus === 'idle') return null

        return (
            <div
                className={`w-2 h-2 rounded-full shrink-0 ${awaitingInput ? AWAITING_INPUT_COLOR : SESSION_STATUS_COLORS[sessionStatus]}`}
                title={awaitingInput ? 'Waiting for you (approval or input needed)' : SESSION_STATUS_TITLES[sessionStatus]}
            />
        )
    }

    return (
        <div
            className="relative"
            ref={itemRef}
            draggable
            onDragStart={(e) => {
                // HTML5 drag of the whole row: onto the terminal area for split view, onto another
                // row to relate the two, onto a session folder in the All sessions view to file it
                e.dataTransfer.setData(SESSION_DRAG_TYPE, session.id)
                e.dataTransfer.setData('application/x-workspace-id', workspace.id)
                e.dataTransfer.effectAllowed = 'move'
                drop?.beginDrag(session.id)
                onDragStartSession?.(session.id)
            }}
            onDragEnd={() => {
                drop?.endDrag()
                onDragEndSession?.()
            }}
            onDragEnter={acceptRelate}
            onDragOver={acceptRelate}
            onDragLeave={relateTarget.leave}
            onDrop={(e) => {
                if (!takesDrop || !isSessionDrag(e)) return
                e.preventDefault()
                e.stopPropagation()
                relateTarget.clear()
                drop?.onRelate(session.id, e.dataTransfer.getData(SESSION_DRAG_TYPE) || drop.draggingId!)
            }}
        >
            {relateTarget.over && (
                <div
                    data-session-relate-target={session.id}
                    className="pointer-events-none absolute inset-0 z-10 rounded ring-1 ring-inset ring-emerald-400/70 bg-emerald-500/10"
                >
                    <span className="absolute right-1 top-1/2 -translate-y-1/2 px-1.5 py-px rounded bg-emerald-600/90 text-[10px] text-white">Relate</span>
                </div>
            )}
            <Reorder.Item
                value={session}
                dragListener={false}
                dragControls={dragControls}
                transition={{ layout: { duration: 0 } }}
                data-session-item={session.id}
                data-session-role={role}
                data-tree-depth={treeDepth > 0 ? treeDepth : undefined}
                data-tree-holds-active={treeBranch?.holdsActive ? session.id : undefined}
                data-tree-connector={treeGuide && treeDepth > 0 ? (treeGuide.continues ? 'tee' : 'elbow') : undefined}
                data-tree-through={treeGuide?.through.length ? treeGuide.through.join(' ') : undefined}
                data-tree-opens-down={treeGuide?.opensDown ? '' : undefined}
                style={treeDepth > 0 ? { paddingLeft: TREE_ROW_PAD_PX + treeDepth * TREE_INDENT_PX } : undefined}
                className={clsx(
                    "flex items-center gap-1 py-1 px-1.5 rounded transition-colors text-sm group",
                    treeGuide && 'relative',
                    isActive ? rowClasses.active : rowClasses.idle,
                    treeBranch?.holdsActive && 'shadow-[inset_2px_0_0_0_rgba(96,165,250,0.9)] bg-blue-500/5'
                )}
                onContextMenu={(e) => onContextMenu(e, workspace.id, session.id)}
                onMouseEnter={handleMouseEnter}
                onMouseLeave={handleMouseLeave}
                whileDrag={{
                    scale: 1.02,
                    boxShadow: "0 4px 12px rgba(0,0,0,0.3)"
                    // Note: backgroundColor 제거 - 드래그 종료 후에도 색상이 유지되는 버그 방지
                }}
            >
                {treeGuide && <TreeGuideLines depth={treeDepth} guide={treeGuide} leaf={!treeBranch} />}
                {/* One slot ahead of the icon: the fold button where there is something under the row, else a blank
                    that a child's guide arm crosses. */}
                {treeBranch ? (
                    <button
                        type="button"
                        data-tree-toggle={session.id}
                        aria-expanded={!treeBranch.collapsed}
                        onClick={(e) => {
                            e.stopPropagation()
                            treeBranch.onToggle()
                        }}
                        className="shrink-0 w-3 flex justify-center rounded text-gray-500 hover:text-white hover:bg-white/10"
                        title={treeBranch.collapsed ? `Show the ${treeBranch.hiddenCount} below` : 'Fold what is below'}
                    >
                        {treeBranch.collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                    </button>
                ) : treeBranch === null && (
                    <span aria-hidden className="shrink-0 w-3" />
                )}
                {/* Split indicator */}
                {isInSplit && (
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" title="In split view" />
                )}

                {/* 드래그 핸들 - framer-motion drag only for reorder within workspace */}
                {!hideDragHandle && <div
                    draggable={false}
                    onDragStart={(e) => {
                        // Prevent HTML5 drag on handle - let framer-motion handle it
                        e.preventDefault()
                        e.stopPropagation()
                    }}
                    onPointerDown={(e) => {
                        // framer-motion drag for reorder within workspace
                        // Only start if left-click
                        if (e.button === 0) {
                            e.preventDefault()
                            e.stopPropagation()
                            dragControls.start(e)
                        }
                    }}
                    className="cursor-grab active:cursor-grabbing p-0.5 opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity shrink-0"
                    title="Drag to reorder"
                >
                    <GripVertical size={12} className="text-gray-500" />
                </div>}

                <div
                    onClick={() => !isRenaming && onSelect(workspace, session)}
                    className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                >
                    {selection ? (
                        // Same 14px slot as the icon, so names do not shift when the box appears.
                        <span className="relative shrink-0 flex w-[14px] h-[14px]">
                            <span className={clsx('flex', selection.active ? 'invisible' : 'group-hover:invisible')}>
                                {roleIcon}
                            </span>
                            <input
                                type="checkbox"
                                data-session-select={session.id}
                                checked={selection.isSelected(session.id)}
                                onClick={(e) => e.stopPropagation()}
                                onChange={() => selection.toggle(session.id)}
                                aria-label={`Select ${session.name}`}
                                title="Select — copy IDs or open side by side"
                                className={clsx(
                                    'absolute inset-0 m-0 w-[14px] h-[14px] cursor-pointer accent-blue-500',
                                    selection.active ? 'visible' : 'invisible group-hover:visible'
                                )}
                            />
                        </span>
                    ) : roleIcon}
                    {isRenaming ? (
                        <input
                            ref={inputRef}
                            type="text"
                            value={tempName}
                            onChange={(e) => setTempName(e.target.value)}
                            onBlur={handleRenameSubmit}
                            onKeyDown={handleKeyDown}
                            className="flex-1 bg-black/50 border border-blue-500/50 rounded px-1 py-0.5 text-xs text-white focus:outline-none min-w-0"
                            onClick={(e) => e.stopPropagation()}
                        />
                    ) : workspaceLabel && workspaceLabelFromEnd ? (
                        <NameWithPath name={session.name} path={workspaceLabel} fontSize={fontSize} />
                    ) : (
                        <span className={workspaceLabel ? 'truncate min-w-0' : 'truncate flex-1'} style={{ fontSize: `${fontSize}px` }}>{session.name}</span>
                    )}
                    {session.isPinned && !isRenaming && (
                        <span title="Pinned to the top of All sessions" data-session-pinned={session.id} className="shrink-0">
                            <Pin size={10} className="text-blue-400" />
                        </span>
                    )}
                    {treeBranch?.collapsed && !isRenaming && (
                        <span
                            data-tree-hidden-count={session.id}
                            className="shrink-0 px-1 rounded bg-white/5 text-[10px] text-gray-500"
                            title={`${treeBranch.hiddenCount} folded below`}
                        >
                            +{treeBranch.hiddenCount}
                        </span>
                    )}
                    {workspaceLabel && !workspaceLabelFromEnd && !isRenaming && (
                        <span
                            data-testid="session-workspace-label"
                            className="flex-1 min-w-0 truncate text-[10px] text-gray-500"
                            title={workspaceLabel}
                        >
                            {workspaceLabel}
                        </span>
                    )}
                    {getSessionStatusBadge()}
                    <InboxDot sessionId={session.id} />
                </div>
                {!isRenaming && (
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onRemove(workspace.id, session.id)
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 hover:bg-red-500/20 rounded transition-all shrink-0"
                        title="Delete session"
                    >
                        <Trash2 size={12} className="text-gray-500 hover:text-red-400" />
                    </button>
                )}
            </Reorder.Item>

            {/* Terminal Preview Popover - rendered via Portal to escape overflow:hidden */}
            {createPortal(
                <AnimatePresence>
                    {showPreview && previewLines && previewLines.length > 0 && itemRef.current && (() => {
                        const rect = itemRef.current.getBoundingClientRect()
                        return (
                            <motion.div
                                initial={{ opacity: 0, x: -8 }}
                                animate={{ opacity: 1, x: 0 }}
                                exit={{ opacity: 0, x: -8 }}
                                transition={{ duration: 0.15 }}
                                className="fixed pointer-events-none"
                                style={{
                                    top: rect.top,
                                    left: rect.right + 8,
                                    minWidth: '280px',
                                    maxWidth: '400px',
                                    zIndex: 9999
                                }}
                            >
                                <div className="bg-gray-900/95 backdrop-blur-sm border border-gray-700/50 rounded-lg shadow-xl overflow-hidden">
                                    {/* Header */}
                                    <div className="px-3 py-1.5 bg-gray-800/50 border-b border-gray-700/50 flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2 min-w-0">
                                            <Terminal size={12} className="text-gray-400 shrink-0" />
                                            <span className="text-xs text-gray-400 truncate">{session.name}</span>
                                        </div>
                                        <span className="text-[10px] text-gray-500 shrink-0">Disable in Settings → Terminal</span>
                                    </div>
                                    {/* Preview content */}
                                    <div className="p-2">
                                        <pre className="text-xs text-gray-300 font-mono whitespace-pre-wrap break-all leading-relaxed">
                                            {previewLines.join('\n')}
                                        </pre>
                                    </div>
                                </div>
                            </motion.div>
                        )
                    })()}
                </AnimatePresence>,
                document.body
            )}
        </div>
    )
}
