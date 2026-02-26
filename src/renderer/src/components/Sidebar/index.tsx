import React, { useState, useEffect, useRef, useCallback } from 'react'
import { Plus, PanelLeftClose, GripVertical } from 'lucide-react'
import { Reorder, useDragControls } from 'framer-motion'
import { Workspace, TerminalSession, SessionStatus, HooksSettings, SplitTerminalLayout } from '../../../../shared/types'
import { useWorkspaceBranches } from '../../hooks/useWorkspaceBranches'
import { useTemplates } from '../../hooks/useTemplates'
import { WorkspaceItem } from './WorkspaceItem'
import { WorkspaceContextMenu, WorktreeContextMenu, BranchMenu, SessionContextMenu } from './ContextMenus'
import { BranchPromptModal } from './Modals'

/**
 * ReorderableWorkspace - 워크스페이스 드래그 앤 드롭을 위한 래퍼 컴포넌트
 * 각 워크스페이스마다 useDragControls 훅을 사용해야 하므로 별도 컴포넌트로 분리
 */
interface ReorderableWorkspaceProps {
    workspace: Workspace
    children: React.ReactNode
    onDragStart: () => void
    onDragEnd: () => void
}

function ReorderableWorkspace({ workspace, children, onDragStart, onDragEnd }: ReorderableWorkspaceProps) {
    const dragControls = useDragControls()

    return (
        <Reorder.Item
            value={workspace}
            dragListener={false}
            dragControls={dragControls}
            transition={{ layout: { duration: 0 } }}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
        >
            <div className="group/workspace relative">
                {/* Workspace drag handle */}
                <div
                    onPointerDown={(e) => {
                        if (e.button === 0) {
                            e.preventDefault()
                            e.stopPropagation()
                            dragControls.start(e)
                        }
                    }}
                    className="absolute left-0 top-1/2 -translate-y-1/2 -translate-x-1 z-10 cursor-grab active:cursor-grabbing p-0.5 opacity-0 group-hover/workspace:opacity-50 hover:!opacity-100 transition-opacity"
                    title="Drag to reorder workspace"
                >
                    <GripVertical size={12} className="text-gray-500" />
                </div>
                {children}
            </div>
        </Reorder.Item>
    )
}

interface SidebarProps {
    workspaces: Workspace[]
    onSelect: (workspace: Workspace, session: TerminalSession) => void
    onAddWorkspace: () => void
    onRemoveWorkspace: (id: string) => void
    onAddSession: (workspaceId: string, type: 'regular' | 'worktree', branchName?: string, initialCommand?: string, sessionName?: string) => void
    onAddWorktreeWorkspace: (parentWorkspaceId: string, branchName: string) => void
    onRemoveSession: (workspaceId: string, sessionId: string, skipConfirm?: boolean) => Promise<void>
    onCreatePlayground: () => void
    activeSessionId?: string
    sessionStatuses?: Map<string, { status: SessionStatus, isClaudeCode: boolean }>
    hooksSettings?: HooksSettings
    terminalPreview?: { enabled: boolean; lineCount: number }
    onOpenInEditor: (workspacePath: string) => void
    onReloadWorktrees: () => Promise<void>
    onOpenSettings: () => void
    settingsOpen?: boolean
    onRenameSession: (workspaceId: string, sessionId: string, newName: string) => void
    onReorderSessions: (workspaceId: string, sessions: TerminalSession[]) => void
    onReorderWorkspaces: (workspaces: Workspace[]) => void
    onTogglePin: (workspaceId: string) => void
    width: number
    setWidth: (width: number) => void
    onClose: () => void
    fontSize?: number  // Sidebar font size for workspace/session names
    showSessionCount?: boolean  // Show session count next to workspace names
    // Split view props
    splitLayout?: SplitTerminalLayout | null
    onDragStartSession?: (sessionId: string) => void
    onDragEndSession?: () => void
}

/**
 * 사이드바 컴포넌트
 * 워크스페이스와 터미널 세션 관리 UI 제공
 *
 * 리팩토링 포인트:
 * - 820줄에서 200줄 이하로 축소
 * - 커스텀 훅으로 상태 관리 분리 (useWorkspaceBranches, useTemplates)
 * - 재사용 가능한 컴포넌트로 분리 (WorkspaceItem, ContextMenus, Modals)
 */
export function Sidebar({
    workspaces,
    onSelect,
    onAddWorkspace,
    onRemoveWorkspace,
    onAddSession,
    onAddWorktreeWorkspace,
    onRemoveSession,
    onCreatePlayground,
    activeSessionId,
    sessionStatuses,
    hooksSettings,
    terminalPreview,
    onOpenInEditor,
    onReloadWorktrees,
    onOpenSettings,
    settingsOpen,
    onRenameSession,
    onReorderSessions,
    onReorderWorkspaces,
    onTogglePin,
    width,
    setWidth,
    onClose,
    fontSize = 14,
    showSessionCount = false,
    splitLayout,
    onDragStartSession,
    onDragEndSession
}: SidebarProps) {
    // 커스텀 훅으로 상태 관리
    const customTemplates = useTemplates(settingsOpen)
    const { workspaceBranches, setWorkspaceBranches } = useWorkspaceBranches(workspaces)

    // UI 상태
    const [expanded, setExpanded] = useState<Set<string>>(new Set())
    const [menuOpen, setMenuOpen] = useState<{ x: number, y: number, workspaceId: string, workspacePath: string } | null>(null)
    const [worktreeMenuOpen, setWorktreeMenuOpen] = useState<{ x: number, y: number, workspace: Workspace } | null>(null)
    const [branchMenuOpen, setBranchMenuOpen] = useState<{ x: number, y: number, workspaceId: string, workspacePath: string } | null>(null)
    const [sessionMenuOpen, setSessionMenuOpen] = useState<{ x: number, y: number, workspaceId: string, sessionId: string } | null>(null)
    const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null)
    const [showPrompt, setShowPrompt] = useState<{ workspaceId: string } | null>(null)
    const [branchLoading, setBranchLoading] = useState(false)

    // Resizing logic (horizontal - sidebar width)
    const isResizing = useRef(false)
    const sidebarRef = useRef<HTMLDivElement>(null)

    // Track previous workspace IDs for detecting new additions
    const prevWorkspaceIdsRef = useRef<Set<string>>(new Set())

    // Track workspace drag state to prevent toggle on drag
    const isDraggingWorkspaceRef = useRef(false)

    // Vertical resizing logic (Playground section height)
    const [playgroundHeight, setPlaygroundHeight] = useState(() => {
        // Load saved height from localStorage, default to 200px
        const saved = localStorage.getItem('sidebar-playground-height')
        return saved ? parseInt(saved, 10) : 200
    })
    const isResizingVertical = useRef(false)
    const sidebarContainerRef = useRef<HTMLDivElement>(null)

    const startResizing = useCallback(() => {
        isResizing.current = true
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none' // Prevent text selection while resizing
    }, [])

    const stopResizing = useCallback(() => {
        isResizing.current = false
        document.body.style.cursor = ''
        document.body.style.userSelect = ''
    }, [])

    const resize = useCallback(
        (mouseMoveEvent: MouseEvent) => {
            if (isResizing.current) {
                const newWidth = mouseMoveEvent.clientX
                if (newWidth >= 50 && newWidth <= 480) { // Min 50px, Max 480px
                    setWidth(newWidth)
                }
            }
        },
        [setWidth]
    )

    // Vertical resize functions for Playground section
    const startResizingVertical = useCallback(() => {
        isResizingVertical.current = true
        document.body.style.cursor = 'row-resize'
        document.body.style.userSelect = 'none'
    }, [])

    const stopResizingVertical = useCallback(() => {
        if (isResizingVertical.current) {
            isResizingVertical.current = false
            document.body.style.cursor = ''
            document.body.style.userSelect = ''
            // Save to localStorage when resize ends
            localStorage.setItem('sidebar-playground-height', playgroundHeight.toString())
        }
    }, [playgroundHeight])

    const resizeVertical = useCallback(
        (mouseMoveEvent: MouseEvent) => {
            if (isResizingVertical.current && sidebarContainerRef.current) {
                const containerRect = sidebarContainerRef.current.getBoundingClientRect()
                // Calculate height from bottom of container to mouse position
                const newHeight = containerRect.bottom - mouseMoveEvent.clientY
                // Min 100px, Max 60% of container height
                const maxHeight = containerRect.height * 0.6
                if (newHeight >= 100 && newHeight <= maxHeight) {
                    setPlaygroundHeight(newHeight)
                }
            }
        },
        []
    )

    useEffect(() => {
        window.addEventListener('mousemove', resize)
        window.addEventListener('mouseup', stopResizing)
        return () => {
            window.removeEventListener('mousemove', resize)
            window.removeEventListener('mouseup', stopResizing)
        }
    }, [resize, stopResizing])

    useEffect(() => {
        window.addEventListener('mousemove', resizeVertical)
        window.addEventListener('mouseup', stopResizingVertical)
        return () => {
            window.removeEventListener('mousemove', resizeVertical)
            window.removeEventListener('mouseup', stopResizingVertical)
        }
    }, [resizeVertical, stopResizingVertical])

    // Listen for rename session request from keyboard shortcut
    useEffect(() => {
        const handleRenameRequest = (e: CustomEvent<{ sessionId: string }>) => {
            setRenamingSessionId(e.detail.sessionId)
        }
        window.addEventListener('rename-session-request', handleRenameRequest as EventListener)
        return () => {
            window.removeEventListener('rename-session-request', handleRenameRequest as EventListener)
        }
    }, [])

    // Helper functions for native dialogs with app logo
    const showAlert = useCallback(async (title: string, message: string, type: 'info' | 'warning' | 'error' = 'info') => {
        await window.api.showMessageBox({ type, title, message, buttons: ['OK'] })
    }, [])

    const showConfirm = useCallback(async (title: string, message: string): Promise<boolean> => {
        const result = await window.api.showMessageBox({
            type: 'question',
            title,
            message,
            buttons: ['Cancel', 'OK']
        })
        return result.response === 1
    }, [])

    // 새로 추가된 워크스페이스만 자동 펼치기
    useEffect(() => {
        const currentIds = new Set(workspaces.map(w => w.id))
        const prevIds = prevWorkspaceIdsRef.current

        // Find newly added workspaces
        const newIds = [...currentIds].filter(id => !prevIds.has(id))

        if (newIds.length > 0) {
            setExpanded(prev => {
                const next = new Set(prev)
                newIds.forEach(id => next.add(id))
                return next
            })
        }

        // Clean up deleted workspace IDs from expanded set
        setExpanded(prev => {
            const next = new Set([...prev].filter(id => currentIds.has(id)))
            // Only update if something was removed
            if (next.size !== prev.size) {
                return next
            }
            return prev
        })

        prevWorkspaceIdsRef.current = currentIds
    }, [workspaces])

    // 메뉴 외부 클릭 시 닫기
    useEffect(() => {
        const handleClick = () => {
            setMenuOpen(null)
            setBranchMenuOpen(null)
            setWorktreeMenuOpen(null)
            setSessionMenuOpen(null)
        }
        window.addEventListener('click', handleClick)
        return () => window.removeEventListener('click', handleClick)
    }, [])

    const toggleExpand = (id: string) => {
        // Ignore toggle if workspace is being dragged
        if (isDraggingWorkspaceRef.current) return

        setExpanded(prev => {
            const next = new Set(prev)
            next.has(id) ? next.delete(id) : next.add(id)
            return next
        })
    }

    const handleContextMenu = (e: React.MouseEvent, workspaceId: string) => {
        e.preventDefault()
        e.stopPropagation()

        const workspace = workspaces.find(w => w.id === workspaceId)
        if (!workspace) return

        // Worktree workspace인 경우 별도 메뉴
        if (workspace.parentWorkspaceId) {
            setWorktreeMenuOpen({ x: e.clientX, y: e.clientY, workspace })
        } else {
            setMenuOpen({ x: e.clientX, y: e.clientY, workspaceId, workspacePath: workspace.path })
        }
    }

    const handleSessionContextMenu = (e: React.MouseEvent, workspaceId: string, sessionId: string) => {
        e.preventDefault()
        e.stopPropagation()
        setSessionMenuOpen({ x: e.clientX, y: e.clientY, workspaceId, sessionId })
    }

    const handleBranchClick = (e: React.MouseEvent, workspace: Workspace) => {
        e.preventDefault()
        e.stopPropagation()

        const branches = workspaceBranches.get(workspace.id)
        if (!branches) return

        setBranchMenuOpen({
            x: e.clientX,
            y: e.clientY,
            workspaceId: workspace.id,
            workspacePath: workspace.path
        })
    }

    const handleBranchCheckout = async (branchName: string) => {
        if (!branchMenuOpen) return

        try {
            await window.api.gitCheckout(branchMenuOpen.workspacePath, branchName)

            // 브랜치 정보 재로드
            const branches = await window.api.gitListBranches(branchMenuOpen.workspacePath) as { current: string; all: string[]; branches: any; worktreeBranches?: string[] } | null
            if (branches) {
                setWorkspaceBranches(prev => {
                    const next = new Map(prev)
                    next.set(branchMenuOpen.workspaceId, {
                        current: branches.current,
                        all: branches.all.filter((b: string) => !b.startsWith('remotes/')),
                        worktreeBranches: branches.worktreeBranches ?? []
                    })
                    return next
                })
            }
        } catch (err) {
            console.error('Failed to checkout branch:', err)
            await showAlert('Checkout Failed', 'Failed to checkout branch. Make sure you have no uncommitted changes.', 'error')
        }
    }

    // Refresh branch list for current workspace
    const handleBranchRefresh = async () => {
        if (!branchMenuOpen) return

        setBranchLoading(true)
        try {
            const branches = await window.api.gitListBranches(branchMenuOpen.workspacePath) as { current: string; all: string[]; branches: any; worktreeBranches?: string[] } | null
            if (branches) {
                setWorkspaceBranches(prev => {
                    const next = new Map(prev)
                    next.set(branchMenuOpen.workspaceId, {
                        current: branches.current,
                        all: branches.all.filter((b: string) => !b.startsWith('remotes/')),
                        worktreeBranches: branches.worktreeBranches ?? []
                    })
                    return next
                })
            }
        } catch (err) {
            console.error('Failed to refresh branches:', err)
        } finally {
            setBranchLoading(false)
        }
    }

    // Local Git handlers
    const handleMergeToMain = async () => {
        if (!worktreeMenuOpen) return

        const parentWorkspace = workspaces.find(w => w.id === worktreeMenuOpen.workspace.parentWorkspaceId)
        if (!parentWorkspace) {
            await showAlert('Error', 'Parent workspace not found.', 'error')
            return
        }

        // Get the base branch (the branch we branched from), fallback to 'main'
        const baseBranch = worktreeMenuOpen.workspace.baseBranch || 'main'

        console.log('[handleMergeToMain] ========== START ==========')
        console.log('[handleMergeToMain] Worktree:', worktreeMenuOpen.workspace.name)
        console.log('[handleMergeToMain] Worktree path:', worktreeMenuOpen.workspace.path)
        console.log('[handleMergeToMain] Worktree branch:', worktreeMenuOpen.workspace.branchName)
        console.log('[handleMergeToMain] Base branch:', baseBranch)
        console.log('[handleMergeToMain] Parent workspace:', parentWorkspace.name)
        console.log('[handleMergeToMain] Parent path:', parentWorkspace.path)

        const result = await window.api.showMessageBox({
            type: 'question',
            title: 'Merge Worktree',
            message: `Merge "${worktreeMenuOpen.workspace.branchName}" into "${baseBranch}"?\n\nThis will checkout "${baseBranch}" in the parent workspace and merge your changes.`,
            buttons: ['Cancel', 'Merge']
        })

        // response: 0 = Cancel, 1 = Merge
        if (result.response !== 1) return

        try {
            // First, checkout the base branch in parent workspace
            console.log('[handleMergeToMain] Checking out base branch:', baseBranch)
            await window.api.gitCheckout(parentWorkspace.path, baseBranch)

            console.log('[handleMergeToMain] Calling gitMerge...')
            console.log('[handleMergeToMain] - path:', parentWorkspace.path)
            console.log('[handleMergeToMain] - branch:', worktreeMenuOpen.workspace.branchName)

            const mergeResult = await window.api.gitMerge(parentWorkspace.path, worktreeMenuOpen.workspace.branchName!)

            console.log('[handleMergeToMain] gitMerge result:', JSON.stringify(mergeResult, null, 2))

            if (mergeResult.success) {
                console.log('[handleMergeToMain] Merge SUCCESS')
                // Check if already up to date (no actual changes)
                if (mergeResult.data?.alreadyUpToDate) {
                    await showAlert('Already Up to Date', 'The branch has no new commits to merge.')
                } else {
                    await showAlert('Merge Completed', 'Merge completed successfully!')
                }
            } else {
                console.log('[handleMergeToMain] Merge FAILED')
                console.log('[handleMergeToMain] Error:', mergeResult.error)
                console.log('[handleMergeToMain] Conflicts:', mergeResult.data?.conflicts)

                if (mergeResult.data?.conflicts && mergeResult.data.conflicts.length > 0) {
                    // Ask user if they want to open editor to resolve conflicts
                    const openEditor = await showConfirm(
                        'Merge Conflict',
                        `Merge conflict occurred:\n${mergeResult.data.conflicts.join('\n')}\n\nWould you like to open the editor to resolve conflicts?`
                    )
                    if (openEditor) {
                        onOpenInEditor(parentWorkspace.path)
                    }
                } else {
                    await showAlert('Merge Failed', `Merge failed: ${mergeResult.error}`, 'error')
                }
            }
        } catch (err: any) {
            console.error('[handleMergeToMain] Exception:', err)
            await showAlert('Merge Failed', `Merge failed: ${err.message}`, 'error')
        }
        console.log('[handleMergeToMain] ========== END ==========')
    }

    const handlePullFromMain = async () => {
        if (!worktreeMenuOpen) return

        const parentWorkspace = workspaces.find(w => w.id === worktreeMenuOpen.workspace.parentWorkspaceId)
        if (!parentWorkspace) {
            await showAlert('Error', 'Parent workspace not found.', 'error')
            return
        }

        const parentBranches = workspaceBranches.get(parentWorkspace.id)
        const mainBranch = parentBranches?.current || 'main'

        console.log('[handlePullFromMain] ========== START ==========')
        console.log('[handlePullFromMain] Worktree:', worktreeMenuOpen.workspace.name)
        console.log('[handlePullFromMain] Worktree path:', worktreeMenuOpen.workspace.path)
        console.log('[handlePullFromMain] Worktree branch:', worktreeMenuOpen.workspace.branchName)
        console.log('[handlePullFromMain] Main branch to pull:', mainBranch)

        const confirmed = await showConfirm(
            'Pull from Main',
            `Pull changes from "${mainBranch}" into "${worktreeMenuOpen.workspace.branchName}"?`
        )
        if (!confirmed) return

        try {
            console.log('[handlePullFromMain] Calling gitMerge...')
            console.log('[handlePullFromMain] - path:', worktreeMenuOpen.workspace.path)
            console.log('[handlePullFromMain] - branch:', mainBranch)

            const mergeResult = await window.api.gitMerge(worktreeMenuOpen.workspace.path, mainBranch)

            console.log('[handlePullFromMain] gitMerge result:', JSON.stringify(mergeResult, null, 2))

            if (mergeResult.success) {
                console.log('[handlePullFromMain] Pull SUCCESS')
                // Check if already up to date (no actual changes)
                if (mergeResult.data?.alreadyUpToDate) {
                    await showAlert('Already Up to Date', 'No new changes from main branch.')
                } else {
                    await showAlert('Pull Completed', 'Successfully pulled changes from main!')
                }
            } else {
                console.log('[handlePullFromMain] Pull FAILED')
                console.log('[handlePullFromMain] Error:', mergeResult.error)
                console.log('[handlePullFromMain] Conflicts:', mergeResult.data?.conflicts)

                if (mergeResult.data?.conflicts && mergeResult.data.conflicts.length > 0) {
                    // Ask user if they want to open editor to resolve conflicts
                    const openEditor = await showConfirm(
                        'Merge Conflict',
                        `Merge conflict occurred:\n${mergeResult.data.conflicts.join('\n')}\n\nWould you like to open the editor to resolve conflicts?`
                    )
                    if (openEditor) {
                        onOpenInEditor(worktreeMenuOpen.workspace.path)
                    }
                } else {
                    await showAlert('Merge Failed', `Merge failed: ${mergeResult.error}`, 'error')
                }
            }
        } catch (err: any) {
            console.error('[handlePullFromMain] Exception:', err)
            await showAlert('Merge Failed', `Merge failed: ${err.message}`, 'error')
        }
        console.log('[handlePullFromMain] ========== END ==========')
    }

    const handleRenameSubmit = (workspaceId: string, sessionId: string, newName: string) => {
        onRenameSession(workspaceId, sessionId, newName)
        setRenamingSessionId(null)
    }

    const handleTogglePin = (workspaceId: string) => {
        onTogglePin(workspaceId)
    }

    // 홈, 일반 워크스페이스, Playground 분리
    const homeWorkspace = workspaces.find(w => w.isHome)
    const pinnedWorkspaces = workspaces.filter(w => !w.isPlayground && !w.parentWorkspaceId && !w.isHome && w.isPinned)
    const regularWorkspaces = workspaces.filter(w => !w.isPlayground && !w.parentWorkspaceId && !w.isHome && !w.isPinned)
    const playgroundWorkspaces = workspaces.filter(w => w.isPlayground)

    return (
        <>
            {/* Context Menus */}
            {menuOpen && (() => {
                const workspace = workspaces.find(w => w.id === menuOpen.workspaceId)
                return (
                    <WorkspaceContextMenu
                        x={menuOpen.x}
                        y={menuOpen.y}
                        workspacePath={menuOpen.workspacePath}
                        sessions={workspace?.sessions || []}
                        templates={customTemplates}
                        isPinned={workspace?.isPinned}
                        onTogglePin={() => {
                            handleTogglePin(menuOpen.workspaceId)
                            setMenuOpen(null)
                        }}
                        onAddSession={(type, template) => {
                            if (type === 'worktree') {
                                setShowPrompt({ workspaceId: menuOpen.workspaceId })
                            } else {
                                onAddSession(menuOpen.workspaceId, 'regular', undefined, template?.command, template?.name)
                            }
                        }}
                        onTerminateAll={async () => {
                            if (!workspace) return

                            // Check if any session has running processes
                            const runningChecks = await Promise.all(
                                workspace.sessions.map(async s => ({
                                    id: s.id,
                                    running: await window.api.hasRunningProcess(s.id)
                                }))
                            )
                            const hasRunning = runningChecks.some(c => c.running)

                            if (hasRunning) {
                                const confirmed = await showConfirm(
                                    'Terminate All Terminals',
                                    'Some terminals have running processes. Are you sure you want to terminate all?'
                                )
                                if (!confirmed) return
                            }

                            // Copy session IDs first (avoid mutation during iteration)
                            const sessionIds = workspace.sessions.map(s => s.id)

                            // Remove all sessions sequentially (skipConfirm since we already confirmed)
                            for (const sessionId of sessionIds) {
                                await onRemoveSession(menuOpen.workspaceId, sessionId, true)
                            }
                        }}
                        onOpenSettings={onOpenSettings}
                        onReloadWorktrees={async () => {
                            try {
                                await onReloadWorktrees()
                            } catch (err: any) {
                                console.error('Failed to reload worktrees:', err)
                                await showAlert('Reload Failed', err?.message || 'Failed to reload worktrees.', 'error')
                            }
                        }}
                        onClose={() => setMenuOpen(null)}
                    />
                )
            })()}

            {worktreeMenuOpen && (
                <WorktreeContextMenu
                    x={worktreeMenuOpen.x}
                    y={worktreeMenuOpen.y}
                    workspace={worktreeMenuOpen.workspace}
                    templates={customTemplates}
                    onMergeToMain={handleMergeToMain}
                    onPullFromMain={handlePullFromMain}
                    onReloadWorktrees={async () => {
                        try {
                            await onReloadWorktrees()
                        } catch (err: any) {
                            console.error('Failed to reload worktrees:', err)
                            await showAlert('Reload Failed', err?.message || 'Failed to reload worktrees.', 'error')
                        }
                    }}
                    onAddSession={(workspaceId, template) => {
                        onAddSession(workspaceId, 'regular', undefined, template?.command, template?.name)
                    }}
                    onClose={() => setWorktreeMenuOpen(null)}
                />
            )}

            {branchMenuOpen && (
                <BranchMenu
                    x={branchMenuOpen.x}
                    y={branchMenuOpen.y}
                    branches={workspaceBranches.get(branchMenuOpen.workspaceId)?.all || []}
                    currentBranch={workspaceBranches.get(branchMenuOpen.workspaceId)?.current || ''}
                    worktreeBranches={workspaceBranches.get(branchMenuOpen.workspaceId)?.worktreeBranches || []}
                    loading={branchLoading}
                    onCheckout={handleBranchCheckout}
                    onRefresh={handleBranchRefresh}
                    onClose={() => setBranchMenuOpen(null)}
                />
            )}

            {sessionMenuOpen && (
                <SessionContextMenu
                    x={sessionMenuOpen.x}
                    y={sessionMenuOpen.y}
                    sessionId={sessionMenuOpen.sessionId}
                    onRename={() => {
                        setRenamingSessionId(sessionMenuOpen.sessionId)
                        setSessionMenuOpen(null)
                    }}
                    onDelete={() => {
                        onRemoveSession(sessionMenuOpen.workspaceId, sessionMenuOpen.sessionId)
                        setSessionMenuOpen(null)
                    }}
                    onClear={() => {
                        window.api.clearTerminal(sessionMenuOpen.sessionId)
                        setSessionMenuOpen(null)
                    }}
                    onClose={() => setSessionMenuOpen(null)}
                />
            )}

            {/* Modals */}
            {showPrompt && (
                <BranchPromptModal
                    onSubmit={(branchName) => {
                        onAddWorktreeWorkspace(showPrompt.workspaceId, branchName)
                        setShowPrompt(null)
                    }}
                    onCancel={() => setShowPrompt(null)}
                />
            )}

            {/* Sidebar Content */}
            <div
                ref={(el) => {
                    sidebarRef.current = el
                    sidebarContainerRef.current = el
                }}
                className="glass-panel mx-2 mb-2 mt-1 rounded-lg flex flex-col overflow-hidden relative"
                style={{ width: width, minWidth: 50, maxWidth: 480 }}
            >
                <div className="py-1.5 px-2 border-b border-white/10 flex items-center justify-between draggable">
                    <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Workspaces</span>
                    <div className="flex items-center gap-1 no-drag">
                        <button
                            onClick={onAddWorkspace}
                            className="p-1 hover:bg-white/10 rounded transition-colors"
                            title="Add Workspace"
                        >
                            <Plus size={14} className="text-gray-400" />
                        </button>
                        <button
                            onClick={onClose}
                            className="p-1 hover:bg-white/10 rounded transition-colors"
                            title="Close Sidebar"
                        >
                            <PanelLeftClose size={14} className="text-gray-400" />
                        </button>
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
                    {/* Home workspace first */}
                    {homeWorkspace && (
                        <WorkspaceItem
                            key={homeWorkspace.id}
                            workspace={homeWorkspace}
                            childWorktrees={[]}
                            expanded={expanded.has(homeWorkspace.id)}
                            expandedSet={expanded}
                            branchInfo={workspaceBranches.get(homeWorkspace.id)}
                            activeSessionId={activeSessionId}
                            sessionStatuses={sessionStatuses}
                            hooksSettings={hooksSettings}
                            terminalPreview={terminalPreview}
                            renamingSessionId={renamingSessionId}
                            fontSize={fontSize}
                            showSessionCount={showSessionCount}
                            onToggleExpand={toggleExpand}
                            onContextMenu={handleContextMenu}
                            onSessionContextMenu={handleSessionContextMenu}
                            onBranchClick={handleBranchClick}
                            onSelect={onSelect}
                            onRemoveSession={onRemoveSession}
                            onRemoveWorkspace={onRemoveWorkspace}
                            onOpenInEditor={onOpenInEditor}
                            onRenameSession={handleRenameSubmit}
                            onRenameCancel={() => setRenamingSessionId(null)}
                            onReorderSessions={onReorderSessions}
                            splitLayout={splitLayout}
                            onDragStartSession={onDragStartSession}
                            onDragEndSession={onDragEndSession}
                        />
                    )}

                    {/* Pinned workspaces - displayed at top, no drag reorder */}
                    {pinnedWorkspaces.length > 0 && (
                        <>
                            <div className="px-2 pt-1 pb-0.5">
                                <span className="text-[10px] font-semibold text-gray-500 uppercase tracking-wider">Pinned</span>
                            </div>
                            {pinnedWorkspaces.map(workspace => {
                                const childWorktrees = workspaces.filter(w => w.parentWorkspaceId === workspace.id)
                                return (
                                    <WorkspaceItem
                                        key={workspace.id}
                                        workspace={workspace}
                                        childWorktrees={childWorktrees}
                                        expanded={expanded.has(workspace.id)}
                                        expandedSet={expanded}
                                        branchInfo={workspaceBranches.get(workspace.id)}
                                        activeSessionId={activeSessionId}
                                        sessionStatuses={sessionStatuses}
                                        hooksSettings={hooksSettings}
                                        terminalPreview={terminalPreview}
                                        renamingSessionId={renamingSessionId}
                                        fontSize={fontSize}
                                        showSessionCount={showSessionCount}
                                        isPinned={true}
                                        onToggleExpand={toggleExpand}
                                        onContextMenu={handleContextMenu}
                                        onSessionContextMenu={handleSessionContextMenu}
                                        onBranchClick={handleBranchClick}
                                        onSelect={onSelect}
                                        onRemoveSession={onRemoveSession}
                                        onRemoveWorkspace={onRemoveWorkspace}
                                        onOpenInEditor={onOpenInEditor}
                                        onRenameSession={handleRenameSubmit}
                                        onRenameCancel={() => setRenamingSessionId(null)}
                                        onReorderSessions={onReorderSessions}
                                        splitLayout={splitLayout}
                                        onDragStartSession={onDragStartSession}
                                        onDragEndSession={onDragEndSession}
                                    />
                                )
                            })}
                        </>
                    )}

                    {/* Regular workspaces - drag & drop reorder supported */}
                    <Reorder.Group
                        axis="y"
                        values={regularWorkspaces}
                        onReorder={onReorderWorkspaces}
                        className="space-y-0.5"
                    >
                        {regularWorkspaces.map(workspace => {
                            const childWorktrees = workspaces.filter(w => w.parentWorkspaceId === workspace.id)
                            return (
                                <ReorderableWorkspace
                                    key={workspace.id}
                                    workspace={workspace}
                                    onDragStart={() => {
                                        isDraggingWorkspaceRef.current = true
                                    }}
                                    onDragEnd={() => {
                                        // Delay reset so click event is ignored first
                                        setTimeout(() => {
                                            isDraggingWorkspaceRef.current = false
                                        }, 0)
                                    }}
                                >
                                    <WorkspaceItem
                                        workspace={workspace}
                                        childWorktrees={childWorktrees}
                                        expanded={expanded.has(workspace.id)}
                                        expandedSet={expanded}
                                        branchInfo={workspaceBranches.get(workspace.id)}
                                        activeSessionId={activeSessionId}
                                        sessionStatuses={sessionStatuses}
                                        hooksSettings={hooksSettings}
                                        terminalPreview={terminalPreview}
                                        renamingSessionId={renamingSessionId}
                                        fontSize={fontSize}
                                        showSessionCount={showSessionCount}
                                        isPinned={false}
                                        onToggleExpand={toggleExpand}
                                        onContextMenu={handleContextMenu}
                                        onSessionContextMenu={handleSessionContextMenu}
                                        onBranchClick={handleBranchClick}
                                        onSelect={onSelect}
                                        onRemoveSession={onRemoveSession}
                                        onRemoveWorkspace={onRemoveWorkspace}
                                        onOpenInEditor={onOpenInEditor}
                                        onRenameSession={handleRenameSubmit}
                                        onRenameCancel={() => setRenamingSessionId(null)}
                                        onReorderSessions={onReorderSessions}
                                        splitLayout={splitLayout}
                                        onDragStartSession={onDragStartSession}
                                        onDragEndSession={onDragEndSession}
                                    />
                                </ReorderableWorkspace>
                            )
                        })}
                    </Reorder.Group>
                </div>

                {/* Playground Section with Resizable Height */}
                <div
                    className="border-t border-white/10 relative flex flex-col flex-shrink-0"
                    style={{ height: playgroundHeight, minHeight: 100 }}
                >
                    {/* Vertical Resize Handle */}
                    <div
                        className="absolute top-0 left-0 right-0 h-1 cursor-row-resize hover:bg-blue-500/50 transition-colors z-50"
                        onMouseDown={startResizingVertical}
                    />

                    <div className="p-4 flex-1 overflow-hidden flex flex-col">
                        <div className="text-xs font-semibold text-gray-500 mb-2">PLAYGROUND</div>

                        {/* Playground list */}
                        <div className="space-y-0.5 mb-3 flex-1 overflow-y-auto">
                            {playgroundWorkspaces.map(workspace => (
                                <WorkspaceItem
                                    key={workspace.id}
                                    workspace={workspace}
                                    childWorktrees={[]}
                                    expanded={expanded.has(workspace.id)}
                                    expandedSet={expanded}
                                    branchInfo={workspaceBranches.get(workspace.id)}
                                    activeSessionId={activeSessionId}
                                    sessionStatuses={sessionStatuses}
                                    hooksSettings={hooksSettings}
                                    terminalPreview={terminalPreview}
                                    renamingSessionId={renamingSessionId}
                                    fontSize={fontSize}
                                    showSessionCount={showSessionCount}
                                    onToggleExpand={toggleExpand}
                                    onContextMenu={handleContextMenu}
                                    onSessionContextMenu={handleSessionContextMenu}
                                    onBranchClick={handleBranchClick}
                                    onSelect={onSelect}
                                    onRemoveSession={onRemoveSession}
                                    onRemoveWorkspace={onRemoveWorkspace}
                                    onOpenInEditor={onOpenInEditor}
                                    onRenameSession={handleRenameSubmit}
                                    onRenameCancel={() => setRenamingSessionId(null)}
                                    onReorderSessions={onReorderSessions}
                                    splitLayout={splitLayout}
                                    onDragStartSession={onDragStartSession}
                                    onDragEndSession={onDragEndSession}
                                />
                            ))}
                        </div>

                        <button
                            onClick={onCreatePlayground}
                            className="w-full flex items-center gap-2 p-2 rounded hover:bg-white/5 text-sm transition-colors flex-shrink-0"
                        >
                            <Plus size={16} />
                            <span>New Playground</span>
                        </button>
                    </div>
                </div>

                {/* Resize Handle */}
                <div
                    className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-blue-500/50 transition-colors z-50"
                    onMouseDown={startResizing}
                />
            </div>
        </>
    )
}
