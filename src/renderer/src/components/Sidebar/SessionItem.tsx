import React, { useState, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { Terminal, Trash2, GripVertical } from 'lucide-react'
import clsx from 'clsx'
import { Reorder, useDragControls, AnimatePresence, motion } from 'framer-motion'
import { TerminalSession, Workspace, SessionStatus } from '../../../../shared/types'

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

// Hover timing constants
const HOVER_DELAY_MS = 300     // Delay before showing preview
const HOVER_LINGER_MS = 400    // Keep preview visible after mouse leaves

interface SessionItemProps {
    session: TerminalSession
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
}

/**
 * 터미널 세션 항목 컴포넌트
 * 세션 선택, 알림 표시, 삭제 기능 제공
 * 드래그 앤 드롭으로 같은 워크스페이스 내에서 순서 변경 가능
 */
export function SessionItem({
    session,
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
    onDragEndSession
}: SessionItemProps) {
    const [tempName, setTempName] = useState(session.name)
    const [previewLines, setPreviewLines] = useState<string[] | null>(null)
    const [showPreview, setShowPreview] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)
    const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const lingerTimeoutRef = useRef<NodeJS.Timeout | null>(null)
    const itemRef = useRef<HTMLDivElement>(null)
    const dragControls = useDragControls()

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
                // HTML5 drag for split view (entire item can be dragged to terminal area)
                e.dataTransfer.setData('application/x-session-id', session.id)
                e.dataTransfer.setData('application/x-workspace-id', workspace.id)
                e.dataTransfer.effectAllowed = 'move'
                onDragStartSession?.(session.id)
            }}
            onDragEnd={() => {
                onDragEndSession?.()
            }}
        >
            <Reorder.Item
                value={session}
                dragListener={false}
                dragControls={dragControls}
                transition={{ layout: { duration: 0 } }}
                className={clsx(
                    "flex items-center gap-1 py-1 px-1.5 rounded transition-colors text-sm group",
                    isActive
                        ? "bg-blue-500/20 text-blue-200"
                        : "text-gray-400 hover:bg-white/5 hover:text-gray-300"
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
                {/* Split indicator */}
                {isInSplit && (
                    <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" title="In split view" />
                )}

                {/* 드래그 핸들 - framer-motion drag only for reorder within workspace */}
                <div
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
                </div>

                <div
                    onClick={() => !isRenaming && onSelect(workspace, session)}
                    className="flex items-center gap-2 flex-1 min-w-0 cursor-pointer"
                >
                    <Terminal size={14} className="shrink-0" />
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
                    ) : (
                        <span className="truncate flex-1" style={{ fontSize: `${fontSize}px` }}>{session.name}</span>
                    )}
                    {getSessionStatusBadge()}
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
