import React, { useCallback, useState } from 'react'
import { GripVertical, Search, LayoutGrid, GitBranch, Settings, X } from 'lucide-react'
import { TerminalSession, Workspace } from '../../../shared/types'
import { RelatedSessionsButton } from './RelatedSessions/RelatedSessionsButton'

interface SplitTerminalHeaderProps {
    session: TerminalSession
    workspace: Workspace | undefined
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
}

/**
 * Header component for split terminal panes
 * This is a lightweight header-only component that doesn't render TerminalView
 * The actual terminal is rendered separately in App.tsx to prevent unmount/remount
 */
export function SplitTerminalHeader({
    session,
    workspace,
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
    onOpenRelated
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
            className={`pane-header h-8 flex items-center justify-between px-2 border-b shrink-0 transition-colors ${
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
                <div className="flex items-center gap-1.5 min-w-0 truncate">
                    {workspace && (
                        <>
                            <span className="text-xs text-gray-500 truncate max-w-[80px]" title={workspace.name}>
                                {workspace.name}
                            </span>
                            <span className="text-gray-600">/</span>
                        </>
                    )}
                    <span className="text-xs text-gray-300 truncate" title={session.name}>
                        {session.name}
                    </span>
                </div>
            </div>

            {/* Right: Action buttons */}
            <div className="flex items-center gap-0.5 shrink-0">
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
        </div>
    )
}
