import React, { useState, useEffect, useMemo } from 'react'
import { SplitTerminalHeader } from './SplitTerminalHeader'
import { TerminalView } from './TerminalView'
import { Workspace, TerminalSession, SessionStatus, HooksSettings } from '../../../shared/types'

interface FullscreenTerminalViewProps {
    sessionIds: string[]
    terminalFontSize: number
    terminalFontFamily?: string
    shell?: string
    keyboardSettings?: {
        scrollShortcuts: boolean
        showScrollButtons: boolean
    }
    hooksSettings?: HooksSettings
    fileLinksEnabled?: boolean
}

// Find session and its workspace from session ID
function findSessionAndWorkspace(
    sessionId: string,
    workspaces: Workspace[]
): { session: TerminalSession | undefined; workspace: Workspace | undefined } {
    for (const workspace of workspaces) {
        const session = workspace.sessions?.find(s => s.id === sessionId)
        if (session) {
            return { session, workspace }
        }
    }
    return { session: undefined, workspace: undefined }
}

// Calculate grid layout based on terminal count
function getGridClass(count: number): string {
    switch (count) {
        case 1:
            return 'grid-cols-1 grid-rows-1'
        case 2:
            return 'grid-cols-2 grid-rows-1'
        case 3:
            return 'grid-cols-2 grid-rows-2' // 2 on top, 1 spans bottom
        case 4:
            return 'grid-cols-2 grid-rows-2'
        case 5:
            return 'grid-cols-3 grid-rows-2' // 3 on top, 2 centered on bottom
        case 6:
            return 'grid-cols-3 grid-rows-2'
        default:
            return 'grid-cols-2 grid-rows-2'
    }
}

export function FullscreenTerminalView({
    sessionIds,
    terminalFontSize,
    terminalFontFamily,
    shell,
    keyboardSettings,
    hooksSettings,
    fileLinksEnabled = true
}: FullscreenTerminalViewProps) {
    const [workspaces, setWorkspaces] = useState<Workspace[]>([])
    const [sessionStatuses, setSessionStatuses] = useState<Map<string, { status: SessionStatus, isClaudeCode: boolean }>>(new Map())
    const [activeSessionIds, setActiveSessionIds] = useState<string[]>(sessionIds)

    // Load workspaces on mount
    useEffect(() => {
        window.api.getWorkspaces().then(setWorkspaces)
    }, [])

    // Listen for session updates from main window (one-way sync: main → grid)
    useEffect(() => {
        const cleanup = window.api.onGridSessionsUpdated((newSessionIds: string[]) => {
            setActiveSessionIds(newSessionIds)
        })
        return cleanup
    }, [])

    // Handle session status change
    const handleSessionStatusChange = (sessionId: string, status: SessionStatus, isClaudeCode: boolean) => {
        setSessionStatuses(prev => {
            const next = new Map(prev)
            next.set(sessionId, { status, isClaudeCode })
            return next
        })
    }

    // Remove terminal from fullscreen view
    const handleRemoveFromFullscreen = (sessionId: string) => {
        setActiveSessionIds(prev => prev.filter(id => id !== sessionId))
    }

    // Get grid class based on active terminals
    const gridClass = useMemo(() => getGridClass(activeSessionIds.length), [activeSessionIds.length])

    // If no terminals left, show message
    if (activeSessionIds.length === 0) {
        return (
            <div className="h-screen w-screen bg-black/90 flex items-center justify-center">
                <div className="text-gray-500 text-center">
                    <p className="text-lg">No terminals to display</p>
                    <p className="text-sm mt-2">Close this window</p>
                </div>
            </div>
        )
    }

    return (
        <div className="h-screen w-screen bg-black/90 flex flex-col">
            {/* Draggable title bar for window movement */}
            <div className="h-8 draggable flex items-center justify-center shrink-0">
                <span className="text-gray-500 text-xs no-draggable">Grid View ({activeSessionIds.length})</span>
            </div>
            <div className={`flex-1 min-h-0 grid ${gridClass} gap-2 p-2 pt-0`}>
                {activeSessionIds.map((sessionId, index) => {
                    const { session, workspace } = findSessionAndWorkspace(sessionId, workspaces)
                    if (!session) {
                        return (
                            <div key={sessionId} className="bg-black/50 rounded-lg flex items-center justify-center">
                                <span className="text-gray-500 text-sm">Terminal not found</span>
                            </div>
                        )
                    }

                    // For 3 terminals, make the third one span both columns
                    const isThirdInThreeLayout = activeSessionIds.length === 3 && index === 2
                    const gridStyles = isThirdInThreeLayout ? 'col-span-2' : ''

                    return (
                        <div key={sessionId} className={`h-full min-h-0 flex flex-col border border-white/10 rounded-lg overflow-hidden bg-black/20 ${gridStyles}`}>
                            <SplitTerminalHeader
                                session={session}
                                workspace={workspace}
                                onRemove={handleRemoveFromFullscreen}
                            />
                            <div className="flex-1 min-h-0 overflow-hidden">
                                <TerminalView
                                    id={session.id}
                                    cwd={session.cwd}
                                    visible={true}
                                    onSessionStatusChange={handleSessionStatusChange}
                                    fontSize={terminalFontSize}
                                    fontFamily={terminalFontFamily}
                                    shell={shell}
                                    keyboardSettings={keyboardSettings}
                                    hooksSettings={hooksSettings}
                                    fileLinksEnabled={fileLinksEnabled}
                                />
                            </div>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
