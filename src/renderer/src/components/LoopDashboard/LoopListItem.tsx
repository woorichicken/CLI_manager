import React from 'react'
import { motion } from 'framer-motion'
import { X, RotateCcw, BarChart3 } from 'lucide-react'
import { LoopProject, LoopSession, LoopStatus } from '../../../../shared/types'
import { formatRelativeTime } from '../../utils/loopTime'

// -------------------------------------------------------
// Status dot component
// -------------------------------------------------------

interface StatusDotProps {
    status: LoopStatus | undefined
}

function StatusDot({ status }: StatusDotProps) {
    if (!status || status === 'stopped') {
        // Hollow red dot
        return (
            <span
                className="inline-block w-2.5 h-2.5 rounded-full border-2 border-red-500 flex-shrink-0"
                title="Stopped"
            />
        )
    }

    if (status === 'running') {
        return (
            <motion.span
                className="inline-block w-2.5 h-2.5 rounded-full bg-green-500 flex-shrink-0"
                title="Running"
                animate={{ opacity: [1, 0.3, 1] }}
                transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
            />
        )
    }

    // ready — amber/gray
    return (
        <span
            className="inline-block w-2.5 h-2.5 rounded-full bg-amber-500/70 flex-shrink-0"
            title="Ready"
        />
    )
}

// -------------------------------------------------------
// Main component
// -------------------------------------------------------

interface LoopListItemProps {
    project: LoopProject
    session: LoopSession | undefined
    isSelected: boolean
    onSelect: (projectId: string) => void
    onRestart: (sessionId: string) => void
    onRemove: (projectId: string) => void
    onShowStats: (projectId: string) => void
}

export function LoopListItem({
    project,
    session,
    isSelected,
    onSelect,
    onRestart,
    onRemove,
    onShowStats,
}: LoopListItemProps) {
    const loopCount = session?.loopCount ?? 0
    const lastLoopAt = session?.lastLoopAt ?? null
    const status = session?.status

    const handleRemoveClick = (e: React.MouseEvent) => {
        e.stopPropagation()
        onRemove(project.id)
    }

    const handleRestartClick = (e: React.MouseEvent) => {
        e.stopPropagation()
        if (session) {
            onRestart(session.id)
        }
    }

    return (
        <div
            className={[
                'group flex items-center gap-2 px-3 py-2.5 rounded-lg cursor-pointer',
                'transition-colors select-none',
                isSelected
                    ? 'bg-white/10 text-white'
                    : 'text-gray-300 hover:bg-white/5 hover:text-white',
            ].join(' ')}
            onClick={() => onSelect(project.id)}
            title={project.path}
        >
            {/* Status dot */}
            <StatusDot status={status} />

            {/* Project info */}
            <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">{project.name}</span>
                    {/* Loop iteration badge */}
                    <span className="text-xs text-gray-500 font-mono shrink-0">
                        #{loopCount}
                    </span>
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                    {formatRelativeTime(lastLoopAt)}
                </div>
            </div>

            {/* Action buttons */}
            <div className="flex items-center gap-1 shrink-0">
                {/* Stats button — opens the per-loop statistics modal */}
                <button
                    onClick={(e) => {
                        e.stopPropagation()
                        onShowStats(project.id)
                    }}
                    className="p-1 rounded text-gray-500 hover:text-purple-400 hover:bg-white/10 transition-colors opacity-0 group-hover:opacity-100"
                    title="View loop statistics"
                >
                    <BarChart3 size={12} />
                </button>

                {/* Restart button — only when stopped */}
                {status === 'stopped' && session && (
                    <button
                        onClick={handleRestartClick}
                        className="p-1 rounded text-gray-500 hover:text-amber-400 hover:bg-white/10 transition-colors"
                        title="Restart loop"
                    >
                        <RotateCcw size={12} />
                    </button>
                )}

                {/* Remove button — visible on hover */}
                <button
                    onClick={handleRemoveClick}
                    className="p-1 rounded text-gray-600 hover:text-red-400 hover:bg-white/10 transition-colors opacity-0 group-hover:opacity-100"
                    title="Remove from Loop Dashboard"
                >
                    <X size={12} />
                </button>
            </div>
        </div>
    )
}
