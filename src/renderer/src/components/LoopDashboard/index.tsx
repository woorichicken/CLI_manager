import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Infinity as InfinityIcon } from 'lucide-react'
import { TerminalView } from '../TerminalView'
import { LoopList } from './LoopList'
import { LoopStatsModal } from './LoopStatsModal'
import { useLoops } from '../../hooks/useLoops'
import { UserSettings, SessionStatus } from '../../../../shared/types'

// -------------------------------------------------------
// Constants
// -------------------------------------------------------

const LIST_WIDTH = 280 // px — fixed sidebar width

// -------------------------------------------------------
// Helper: load settings once for terminal font/shell prefs
// -------------------------------------------------------

interface TerminalPrefs {
    fontSize: number
    fontFamily?: string
    shell?: string
}

function useTerminalPrefs(): TerminalPrefs {
    const [prefs, setPrefs] = useState<TerminalPrefs>({ fontSize: 14 })

    useEffect(() => {
        window.api.getSettings().then((s: UserSettings) => {
            setPrefs({
                fontSize: 14, // terminal font size managed separately from UI fontSize
                fontFamily: s.terminalFontFamily,
                shell: s.defaultShell,
            })
        }).catch(() => {/* stay at defaults */})
    }, [])

    return prefs
}

// -------------------------------------------------------
// Empty state shown when there are no loop projects
// -------------------------------------------------------

function EmptyDashboard() {
    return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 text-center px-6">
            <InfinityIcon size={40} className="text-purple-400/40" />
            <div>
                <p className="text-gray-400 text-sm font-medium">No loop projects</p>
                <p className="text-gray-600 text-xs mt-1">
                    Right-click a workspace in the main window and choose{' '}
                    <span className="text-gray-500 font-medium">Promote to Loop</span>.
                </p>
            </div>
            <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded max-w-xs w-full">
                <p className="text-xs text-blue-200 text-left">
                    <strong>Tip:</strong> Right-click a workspace in the main window and choose
                    &ldquo;Promote to Loop&rdquo; to track Claude Code /loop iterations here.
                </p>
            </div>
        </div>
    )
}

// -------------------------------------------------------
// Main component
// -------------------------------------------------------

export function LoopDashboard() {
    const { projects, sessions, sessionForProject, openTerminal, restart, remove } = useLoops()
    const prefs = useTerminalPrefs()

    // Which project is currently selected in the list
    const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

    // Track which project IDs have had terminals opened (so we mount TerminalView once and keep it)
    const [openedProjectIds, setOpenedProjectIds] = useState<string[]>([])

    // Which project's stats modal is open (null = closed)
    const [statsProjectId, setStatsProjectId] = useState<string | null>(null)

    // Map from projectId → terminalId (the id passed to TerminalView)
    // When a loop session is created by the main process, it carries a terminalId.
    const terminalIdForProject = useCallback(
        (projectId: string): string | null => {
            const session = sessionForProject(projectId)
            return session?.terminalId ?? null
        },
        [sessionForProject]
    )

    // Auto-select first project when projects load
    useEffect(() => {
        if (projects.length > 0 && selectedProjectId === null) {
            setSelectedProjectId(projects[0].id)
        }
        // If selected project was removed, fall back to first available
        if (
            selectedProjectId !== null &&
            !projects.find((p) => p.id === selectedProjectId)
        ) {
            setSelectedProjectId(projects.length > 0 ? projects[0].id : null)
        }
    }, [projects, selectedProjectId])

    // When a project is selected, ensure we request a terminal for it (once)
    const handleSelectProject = useCallback(
        async (projectId: string) => {
            setSelectedProjectId(projectId)

            // Open terminal if not yet opened for this project
            if (!openedProjectIds.includes(projectId)) {
                setOpenedProjectIds((prev) => [...prev, projectId])
                await openTerminal(projectId)
            }
        },
        [openedProjectIds, openTerminal]
    )

    // On mount: if there's a selected/first project, open its terminal
    const didInitRef = useRef(false)
    useEffect(() => {
        if (didInitRef.current) return
        if (projects.length === 0) return
        didInitRef.current = true

        const firstId = projects[0].id
        setSelectedProjectId(firstId)
        setOpenedProjectIds([firstId])
        openTerminal(firstId)
    }, [projects, openTerminal])

    // Handle restart action
    const handleRestart = useCallback(
        (sessionId: string) => {
            restart(sessionId)
        },
        [restart]
    )

    // Handle remove action
    const handleRemove = useCallback(
        (projectId: string) => {
            remove(projectId)
            // Clean up opened tracking
            setOpenedProjectIds((prev) => prev.filter((id) => id !== projectId))
        },
        [remove]
    )

    // Open the stats modal for a project
    const handleShowStats = useCallback((projectId: string) => {
        setStatsProjectId(projectId)
    }, [])

    // Session status change handler (no-op for now; future: show in list)
    const handleSessionStatusChange = useCallback(
        (_sessionId: string, _status: SessionStatus, _isClaudeCode: boolean) => {
            // Future: could update local UI state based on terminal output detection
        },
        []
    )

    const hasProjects = projects.length > 0

    return (
        <div className="h-screen w-screen flex flex-col bg-black/90 text-white overflow-hidden">
            {/* Draggable title bar */}
            <div className="h-8 draggable flex items-center px-4 shrink-0 border-b border-white/5">
                <div className="flex items-center gap-2 no-draggable">
                    <InfinityIcon size={13} className="text-purple-400" />
                    <span className="text-xs font-semibold text-gray-400">Loop Dashboard</span>
                    {projects.length > 0 && (
                        <span className="text-xs text-gray-600 font-mono">
                            ({projects.length})
                        </span>
                    )}
                </div>
            </div>

            {/* Body */}
            <div className="flex flex-1 min-h-0">
                {/* Left sidebar: loop project list */}
                <div
                    className="flex flex-col border-r border-white/10 bg-black/30 shrink-0 overflow-hidden"
                    style={{ width: LIST_WIDTH }}
                >
                    <LoopList
                        projects={projects}
                        sessions={sessions}
                        selectedProjectId={selectedProjectId}
                        onSelectProject={handleSelectProject}
                        onRestart={handleRestart}
                        onRemove={handleRemove}
                        onShowStats={handleShowStats}
                    />
                </div>

                {/* Right pane: terminal(s) */}
                <div className="flex-1 min-w-0 relative bg-black/10">
                    {!hasProjects ? (
                        <EmptyDashboard />
                    ) : (
                        <>
                            {/* Mount all opened terminals; show only the selected one */}
                            {openedProjectIds.map((projectId) => {
                                const terminalId = terminalIdForProject(projectId)
                                const project = projects.find((p) => p.id === projectId)
                                const isVisible = projectId === selectedProjectId

                                if (!terminalId || !project) {
                                    // Terminal not yet created by main process — show loading placeholder
                                    return isVisible ? (
                                        <div
                                            key={projectId}
                                            className="absolute inset-0 flex items-center justify-center"
                                        >
                                            <div className="text-center">
                                                <div className="text-gray-600 text-sm">
                                                    Starting terminal…
                                                </div>
                                            </div>
                                        </div>
                                    ) : null
                                }

                                return (
                                    <div
                                        key={projectId}
                                        className="absolute inset-0"
                                        style={{ display: isVisible ? 'flex' : 'none' }}
                                    >
                                        <div className="flex-1 min-h-0 overflow-hidden">
                                            <TerminalView
                                                id={terminalId}
                                                cwd={project.path}
                                                visible={isVisible}
                                                onSessionStatusChange={handleSessionStatusChange}
                                                fontSize={prefs.fontSize}
                                                fontFamily={prefs.fontFamily}
                                                shell={prefs.shell}
                                            />
                                        </div>
                                    </div>
                                )
                            })}

                            {/* If selected project has no open terminal yet, show placeholder */}
                            {selectedProjectId !== null &&
                                !openedProjectIds.includes(selectedProjectId) && (
                                    <div className="absolute inset-0 flex items-center justify-center">
                                        <div className="text-gray-600 text-sm">
                                            Select a project to open a terminal
                                        </div>
                                    </div>
                                )}
                        </>
                    )}
                </div>
            </div>

            {/* Per-loop statistics modal */}
            {statsProjectId &&
                (() => {
                    const p = projects.find((pr) => pr.id === statsProjectId)
                    if (!p) return null
                    return (
                        <LoopStatsModal
                            project={p}
                            session={sessionForProject(statsProjectId)}
                            onClose={() => setStatsProjectId(null)}
                        />
                    )
                })()}
        </div>
    )
}
