import React from 'react'
import { Infinity as InfinityIcon } from 'lucide-react'
import { LoopProject, LoopSession } from '../../../../shared/types'
import { LoopListItem } from './LoopListItem'

interface LoopListProps {
    projects: LoopProject[]
    sessions: LoopSession[]
    selectedProjectId: string | null
    onSelectProject: (projectId: string) => void
    onRestart: (sessionId: string) => void
    onRemove: (projectId: string) => void
    onShowStats: (projectId: string) => void
}

export function LoopList({
    projects,
    sessions,
    selectedProjectId,
    onSelectProject,
    onRestart,
    onRemove,
    onShowStats,
}: LoopListProps) {
    const sessionByProject = (projectId: string): LoopSession | undefined =>
        sessions.find((s) => s.loopProjectId === projectId)

    return (
        <div className="flex flex-col h-full">
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-3 border-b border-white/10 shrink-0">
                <InfinityIcon size={14} className="text-purple-400 shrink-0" />
                <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Loop Projects
                </span>
                {projects.length > 0 && (
                    <span className="ml-auto text-xs text-gray-600 font-mono">
                        {projects.length}
                    </span>
                )}
            </div>

            {/* Project list */}
            <div className="flex-1 overflow-y-auto py-1 px-1">
                {projects.length === 0 ? (
                    <EmptyProjectsHint />
                ) : (
                    projects.map((project) => (
                        <LoopListItem
                            key={project.id}
                            project={project}
                            session={sessionByProject(project.id)}
                            isSelected={project.id === selectedProjectId}
                            onSelect={onSelectProject}
                            onRestart={onRestart}
                            onRemove={onRemove}
                            onShowStats={onShowStats}
                        />
                    ))
                )}
            </div>
        </div>
    )
}

function EmptyProjectsHint() {
    return (
        <div className="px-3 py-4">
            <p className="text-xs text-gray-600 leading-relaxed">
                No loop projects yet.
            </p>
            <div className="mt-3 p-3 bg-blue-500/10 border border-blue-500/20 rounded">
                <p className="text-xs text-blue-200">
                    <strong>Tip:</strong> Right-click a workspace in the main window and choose{' '}
                    <em>Promote to Loop</em> to add it here.
                </p>
            </div>
        </div>
    )
}
