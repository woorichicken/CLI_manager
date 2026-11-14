import React, { useCallback, useState } from 'react'
import { Bot, GripVertical, Search, LayoutGrid, GitBranch, Settings, X } from 'lucide-react'
import { TerminalSession, Workspace } from '../../../shared/types'
import { RelatedSessionsButton } from './RelatedSessions/RelatedSessionsButton'
import { SessionBreadcrumb } from './SessionBreadcrumb'
import { SessionViewToggle } from './SessionViewToggle'
import { ParentSessionButton, SessionHistoryButtons } from './SessionNavButtons'
import { isAgentSession } from '../utils/agentSession'
import type { BreadcrumbSegment } from '../utils/sessionBreadcrumb'
import type { SessionHistory } from '../hooks/useSessionHistory'
import type { RelatedEntry } from '../utils/relatedSessions'

interface SplitTerminalHeaderProps {
    session: TerminalSession
    workspace: Workspace | undefined
    breadcrumb: BreadcrumbSegment[] // folder > project > session
    isActive?: boolean // Whether this pane is the active one in split view
    // Pane actions
    onRemove: (sessionId: string) => void
    onOpenSearch?: (workspacePath: string) => void
    onOpenGit?: (workspacePath: string) => void
    onOpenSettings?: () => void
    onOpenFullscreen?: (sessionId: string) => void
    onPaneClick?: () => void // Called when pane is clicked to set as active
    // Drag handlers for drag-out removal and reorder
    onDragStart?: (sessionId: string) => void
    onDragEnd?: () => void
    onReorder?: (fromSessionId: string, toSessionId: string) => void
    // Related sessions dialog
    relatedCount?: number
    onOpenRelated?: (sessionId: string) => void
    /**
     * A pane wide enough for the single-view header row (report 08343040): same height, sizes and
     * controls as the header above a single terminal. Narrow panes keep the compact row.
     */
    wide?: boolean
    fontSize?: number
    /** Back/forward — given to the active pane only: there is one history for the whole window. */
    history?: SessionHistory
    /** The sessions that opened this one; the shortcut shows when there is exactly one. */
    parents?: RelatedEntry[]
    onShowSession?: (sessionId: string) => void
}

/**
 * Header component for split terminal panes
 * This is a lightweight header-only component that doesn't render TerminalView
 * The actual terminal is rendered separately in App.tsx to prevent unmount/remount
 */
export function SplitTerminalHeader({
    session,
    workspace,
    breadcrumb,
    isActive,
    onRemove,
    onOpenSearch,
    onOpenGit,
    onOpenSettings,
    onOpenFullscreen,
    onPaneClick,
    onDragStart,
    onDragEnd,
    onReorder,
    relatedCount = 0,
    onOpenRelated,
    wide = false,
    fontSize,
    history,
    parents = [],
    onShowSession
}: SplitTerminalHeaderProps) {
    const [isDragOver, setIsDragOver] = useState(false)

    // Handle drag start for drag-out removal and reorder
    const handleDragStart = useCallback((e: React.DragEvent) => {
        e.dataTransfer.setData('application/x-split-session-id', session.id)
        e.dataTransfer.effectAllowed = 'move'
        onDragStart?.(session.id)
    }, [session.id, onDragStart])

    const handleDragEnd = useCallback(() => {
        onDragEnd?.()
        setIsDragOver(false)
    }, [onDragEnd])

    // Handle drag over for reorder
    const handleDragOver = useCallback((e: React.DragEvent) => {
        if (e.dataTransfer.types.includes('application/x-split-session-id')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
            setIsDragOver(true)
        }
    }, [])

    const handleDragLeave = useCallback(() => {
        setIsDragOver(false)
    }, [])

    // Handle drop for reorder
    const handleDrop = useCallback((e: React.DragEvent) => {
        e.preventDefault()
        setIsDragOver(false)

        const fromSessionId = e.dataTransfer.getData('application/x-split-session-id')
        if (fromSessionId && fromSessionId !== session.id) {
            onReorder?.(fromSessionId, session.id)
        }
    }, [session.id, onReorder])

    // Button click handlers
    const handleSearchClick = useCallback(() => {
        if (workspace?.path) {
            onOpenSearch?.(workspace.path)
        }
    }, [workspace?.path, onOpenSearch])

    const handleGitClick = useCallback(() => {
        if (workspace?.path) {
            onOpenGit?.(workspace.path)
        }
    }, [workspace?.path, onOpenGit])

    const handleSettingsClick = useCallback(() => {
        onOpenSettings?.()
    }, [onOpenSettings])

    const handleFullscreenClick = useCallback(() => {
        onOpenFullscreen?.(session.id)
    }, [session.id, onOpenFullscreen])

    const handleRemoveClick = useCallback(() => {
        onRemove(session.id)
    }, [session.id, onRemove])

    return (
        <div
            data-pane-header={session.id}
            data-pane-wide={wide ? 'true' : 'false'}
            className={`pane-header ${wide ? 'h-10 pl-2 pr-4 gap-2' : 'h-8 px-2'} flex items-center justify-between border-b shrink-0 transition-colors ${
                isDragOver
                    ? 'bg-blue-500/20 border-blue-500/50'
                    : isActive
                        ? 'bg-blue-500/10 border-blue-500/30'
                        : 'bg-black/30 border-white/10'
            }`}
            onClick={onPaneClick}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
        >
            {/* Left: Draggable area + Workspace/Terminal name */}
            <div
                draggable={true}
                onDragStart={handleDragStart}
                onDragEnd={handleDragEnd}
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
                className="flex items-center gap-2 min-w-0 flex-1 cursor-grab active:cursor-grabbing"
            >
                <div
                    className="p-1 hover:bg-white/10 rounded transition-colors shrink-0"
                    title="Drag to reorder"
                >
                    <GripVertical size={14} className="text-gray-500" />
                </div>
                {wide && history && onShowSession && (
                    <SessionHistoryButtons history={history} onShow={onShowSession} />
                )}
                <SessionBreadcrumb segments={breadcrumb} fontSize={wide ? fontSize : undefined} />
                {wide && session.aiControl && (
                    <span
                        className="flex items-center justify-center w-6 h-6 shrink-0 rounded-full bg-emerald-500/15 border border-emerald-500/30 text-emerald-300"
                        title={`AI connected — driven by ${session.aiControl.client}. Right-click the session → Disconnect AI to take it back.`}
                        aria-label="AI connected"
                        data-ai-badge={session.id}
                    >
                        <Bot size={13} />
                    </span>
                )}
            </div>

            {wide ? renderWideActions() : renderCompactActions()}
        </div>
    )

    // The single-view header's controls at its sizes (p-2, 16px icons, labelled toggles).
    function renderWideActions() {
        const buttonClass = 'p-2 hover:bg-white/10 rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed'
        return (
            <div className="flex items-center gap-2 min-w-0 overflow-x-auto" style={{ scrollbarWidth: 'none' }}>
                {isAgentSession(session) && <SessionViewToggle sessionId={session.id} />}
                {onShowSession && <ParentSessionButton parents={parents} onShow={onShowSession} />}
                {onOpenRelated && (
                    <RelatedSessionsButton sessionId={session.id} count={relatedCount} onOpen={onOpenRelated} />
                )}
                <button onClick={handleSearchClick} className={buttonClass} title="Search Files" disabled={!workspace?.path}>
                    <Search size={16} className="text-gray-400" />
                </button>
                <button onClick={handleGitClick} className={buttonClass} title="Git Panel" disabled={!workspace?.path}>
                    <GitBranch size={16} className="text-gray-400" />
                </button>
                <button onClick={handleFullscreenClick} className={buttonClass} title="Open in Grid Window">
                    <LayoutGrid size={16} className="text-gray-400" />
                </button>
                <button onClick={handleSettingsClick} className={buttonClass} title="Settings">
                    <Settings size={16} className="text-gray-400" />
                </button>
                <button onClick={handleRemoveClick} className="p-2 hover:bg-red-500/20 rounded transition-colors" title="Remove from split">
                    <X size={16} className="text-gray-400 hover:text-red-400" />
                </button>
            </div>
        )
    }

    function renderCompactActions() {
        return (
            <div className="flex items-center gap-0.5 shrink-0">
                {isAgentSession(session) && <SessionViewToggle sessionId={session.id} compact />}
                {onOpenRelated && (
                    <RelatedSessionsButton sessionId={session.id} count={relatedCount} onOpen={onOpenRelated} compact />
                )}
                <button
                    onClick={handleSearchClick}
                    className="p-1 hover:bg-white/10 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Search Files"
                    disabled={!workspace?.path}
                >
                    <Search size={12} className="text-gray-400" />
                </button>
                <button
                    onClick={handleFullscreenClick}
                    className="p-1 hover:bg-white/10 rounded transition-colors"
                    title="Open in Grid Window"
                >
                    <LayoutGrid size={12} className="text-gray-400" />
                </button>
                <button
                    onClick={handleGitClick}
                    className="p-1 hover:bg-white/10 rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                    title="Git Panel"
                    disabled={!workspace?.path}
                >
                    <GitBranch size={12} className="text-gray-400" />
                </button>
                <button
                    onClick={handleSettingsClick}
                    className="p-1 hover:bg-white/10 rounded transition-colors"
                    title="Settings"
                >
                    <Settings size={12} className="text-gray-400" />
                </button>
                <button
                    onClick={handleRemoveClick}
                    className="p-1 hover:bg-red-500/20 rounded transition-colors ml-1"
                    title="Remove from split"
                >
                    <X size={12} className="text-gray-400 hover:text-red-400" />
                </button>
            </div>
        )
    }
}
