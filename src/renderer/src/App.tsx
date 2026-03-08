import React, { useState, useEffect, useMemo, useRef } from 'react'
import { Sidebar } from './components/Sidebar/index'
import { TerminalView } from './components/TerminalView'
import { SessionMemo } from './components/SessionMemo'
import { StatusBar } from './components/StatusBar'
import { Settings } from './components/Settings'
import { GitPanel } from './components/GitPanel'
import { FileSearch } from './components/FileSearch'
import { ConfirmationModal } from './components/Sidebar/Modals'
import { Workspace, WorkspaceFolder, TerminalSession, UserSettings, IPCResult, EditorType, TerminalTemplate, PortActionLog, LicenseInfo, PLAN_LIMITS, SessionStatus, SplitTerminalLayout } from '../../shared/types'
import { getErrorMessage } from './utils/errorMessages'
import { PanelLeft, Search, LayoutGrid, MessageSquare, Monitor } from 'lucide-react'
import { SplitTerminalHeader } from './components/SplitTerminalHeader'
import { FullscreenTerminalView } from './components/FullscreenTerminalView'
import { SystemMonitorPopover } from './components/SystemMonitorPopover'
import { Onboarding } from './components/Onboarding'
import { LicenseVerification } from './components/LicenseVerification'
import { UpdateNotification, UpdateStatus } from './components/UpdateNotification'
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'
import { useTemplates } from './hooks/useTemplates'

function App() {
    const [workspaces, setWorkspaces] = useState<Workspace[]>([])
    const [folders, setFolders] = useState<WorkspaceFolder[]>([])
    // Workspace display order (only affects Sidebar, not terminal rendering)
    const [workspaceOrder, setWorkspaceOrder] = useState<string[]>([])
    // Session display order per workspace (only affects Sidebar, not terminal rendering)
    const [sessionOrders, setSessionOrders] = useState<Map<string, string[]>>(new Map())
    const [activeWorkspace, setActiveWorkspace] = useState<Workspace | null>(null)
    const [activeSession, setActiveSession] = useState<TerminalSession | null>(null)
    const [settingsOpen, setSettingsOpen] = useState(false)
    const [gitPanelOpen, setGitPanelOpen] = useState(false)
    const [fileSearchOpen, setFileSearchOpen] = useState(false)
    const [fileSearchMode, setFileSearchMode] = useState<'files' | 'content'>('files')
    const [showMonitor, setShowMonitor] = useState(false)
    const monitorButtonRef = useRef<HTMLButtonElement>(null)

    // Split terminal view state
    const [splitLayout, setSplitLayout] = useState<SplitTerminalLayout | null>(null)
    const [isDraggingSession, setIsDraggingSession] = useState(false)
    const [dragOverZone, setDragOverZone] = useState<'split' | null>(null)
    const [activeSplitIndex, setActiveSplitIndex] = useState<number>(0) // Which pane is active in split view

    // Fullscreen terminal mode (for separate window)
    const [isFullscreenMode, setIsFullscreenMode] = useState(false)
    const [fullscreenSessionIds, setFullscreenSessionIds] = useState<string[]>([])

    // Grid view state (sessions currently open in grid window)
    const [gridViewSessionIds, setGridViewSessionIds] = useState<string[]>([])

    // Check URL parameters for fullscreen mode
    useEffect(() => {
        const params = new URLSearchParams(window.location.search)
        if (params.get('mode') === 'fullscreen') {
            setIsFullscreenMode(true)
            const sessions = params.get('sessions')
            if (sessions) {
                setFullscreenSessionIds(sessions.split(','))
            }
        }
    }, [])

    // Listen for grid view state changes
    useEffect(() => {
        const cleanup = window.api.onGridViewStateChanged((isOpen, sessionIds) => {
            setGridViewSessionIds(isOpen ? sessionIds : [])
        })
        return cleanup
    }, [])

    // Listen for CLI session detection (manual typing interception)
    useEffect(() => {
        const cleanup = window.api.onCliSessionDetected((data) => {
            setWorkspaces(prev => prev.map(ws => {
                if (ws.id !== data.workspaceId) return ws
                return {
                    ...ws,
                    sessions: ws.sessions.map(s => {
                        if (s.id !== data.sessionId) return s
                        return { ...s, cliSessionId: data.cliSessionId, cliToolName: data.cliToolName }
                    })
                }
            }))
        })
        return cleanup
    }, [])

    // Track previous isClaudeCode state to detect exit transitions (true → false)
    const prevClaudeCodeRef = useRef<Map<string, boolean>>(new Map())

    // Session status tracking for Claude Code hooks (claude-squad style)
    const [sessionStatuses, setSessionStatuses] = useState<Map<string, { status: SessionStatus, isClaudeCode: boolean }>>(new Map())
    const [settings, setSettings] = useState<UserSettings>({
        theme: 'dark',
        fontSize: 14,
        fontFamily: 'Monaco, Courier New, monospace',
        defaultShell: 'zsh',
        defaultEditor: 'vscode',
        portFilter: {
            enabled: true,
            minPort: 3000,
            maxPort: 9000
        },
        notifications: {
            enabled: false,  // 기본값을 false로 설정 (알림 끄기)
            tools: {
                cc: true,
                codex: true,
                gemini: true,
                generic: true
            }
        }
    })
    const [confirmationModal, setConfirmationModal] = useState<{
        isOpen: boolean
        title: string
        message: string
        onConfirm: () => void
    }>({
        isOpen: false,
        title: '',
        message: '',
        onConfirm: () => { }
    })

    // Sidebar state
    const [sidebarWidth, setSidebarWidth] = useState(256)
    const [isSidebarOpen, setIsSidebarOpen] = useState(true)

    // Onboarding state
    const [showOnboarding, setShowOnboarding] = useState(false)
    const [showLicenseVerification, setShowLicenseVerification] = useState(false)

    // Update notification state
    const [showUpdateNotification, setShowUpdateNotification] = useState(false)
    const [updateVersion, setUpdateVersion] = useState<string>('')
    const [updateStatus, setUpdateStatus] = useState<UpdateStatus>('available')
    const [updatePercent, setUpdatePercent] = useState(0)

    // License state
    const [licenseInfo, setLicenseInfo] = useState<LicenseInfo>({
        planType: 'free',
        license: null,
        limits: PLAN_LIMITS.free,
        isExpired: false
    })

    // 터미널 폰트 크기 (settings.fontSize와 별도 관리 - Cmd+/-로만 조절)
    const [terminalFontSize, setTerminalFontSize] = useState(14)
    const skipSessionRestore = import.meta.env.VITE_NO_SESSION_RESTORE === 'true'

    // Custom templates for keyboard shortcuts (Cmd+T → number)
    const customTemplates = useTemplates(settingsOpen)

    // 터미널 폰트 크기 조정 상수
    const MIN_FONT_SIZE = 8
    const MAX_FONT_SIZE = 32
    const FONT_SIZE_STEP = 1

    // Load workspaces, settings, and license info on mount
    useEffect(() => {
        const loadInitialData = async () => {
            try {
                // Startup one-time sync: import/remove worktree workspaces based on git worktree list.
                const syncResult = await window.api.syncWorktreeWorkspaces()
                if (!syncResult.success) {
                    console.error('[startup-sync] Failed to sync worktrees:', syncResult.error)
                }
            } catch (err) {
                console.error('[startup-sync] Failed to sync worktrees:', err)
            }

            const loadedWorkspaces = await window.api.getWorkspaces()
            const loadedFolders = await window.api.getFolders()
            setFolders(loadedFolders)
            if (skipSessionRestore) {
                // Clear all sessions but keep workspaces
                const workspacesWithoutSessions = loadedWorkspaces.map(w => ({
                    ...w,
                    sessions: []
                }))
                setWorkspaces(workspacesWithoutSessions)
            } else {
                setWorkspaces(loadedWorkspaces)
            }
            // Initialize workspace order from loaded workspaces (regular workspaces only)
            const regularIds = loadedWorkspaces
                .filter(w => !w.isPlayground && !w.parentWorkspaceId && !w.isHome)
                .map(w => w.id)
            setWorkspaceOrder(regularIds)
            // Initialize session orders from loaded workspaces (skip if no restore)
            const initialSessionOrders = new Map<string, string[]>()
            if (!skipSessionRestore) {
                loadedWorkspaces.forEach(w => {
                    if (w.sessions && w.sessions.length > 0) {
                        initialSessionOrders.set(w.id, w.sessions.map(s => s.id))
                    }
                })
            }
            setSessionOrders(initialSessionOrders)
        }

        loadInitialData().catch(err => {
            console.error('Failed to load workspaces:', err)
        })

        window.api.getSettings().then(loadedSettings => {
            if (loadedSettings) {
                setSettings(loadedSettings)
                if (!loadedSettings.hasCompletedOnboarding) {
                    setShowOnboarding(true)
                }
                // Show license verification for first-time users
                if (!loadedSettings.licenseScreenCompleted) {
                    setShowLicenseVerification(true)
                }
            }
        }).catch(err => {
            console.error('Failed to load settings:', err)
        })

        // Load license info
        loadLicenseInfo()
    }, [])

    // Check for updates on app start
    useEffect(() => {
        const checkUpdate = async () => {
            try {
                const result = await window.api.checkForUpdate() as any
                if (result.success && result.hasUpdate && result.version) {
                    setUpdateVersion(result.version)
                    setShowUpdateNotification(true)
                }
            } catch (error) {
                console.log('Update check failed:', error)
            }
        }

        // Check after a short delay to let the app initialize
        const timer = setTimeout(checkUpdate, 2000)
        return () => clearTimeout(timer)
    }, [])

    // Listen for update status changes (downloading, ready, etc.)
    useEffect(() => {
        const cleanup = window.api.onUpdateStatus((data) => {
            if (data.status === 'downloading') {
                setUpdateStatus('downloading')
                setUpdatePercent(data.percent || 0)
            } else if (data.status === 'ready' && data.version) {
                setUpdateVersion(data.version)
                setUpdateStatus('ready')
                setShowUpdateNotification(true)
            }
        })
        return cleanup
    }, [])

    // Cmd+/- 터미널 폰트 크기 조정 (Main process에서 IPC로 전달받음)
    // settings.fontSize는 UI용이므로 별도의 terminalFontSize 상태를 조절
    useEffect(() => {
        const cleanup = window.api.onTerminalZoom((key: string) => {
            // Cmd/Ctrl + = 또는 + (확대)
            if (key === '=' || key === '+') {
                setTerminalFontSize(prev => Math.min(prev + FONT_SIZE_STEP, MAX_FONT_SIZE))
            }
            // Cmd/Ctrl + - (축소)
            else if (key === '-') {
                setTerminalFontSize(prev => Math.max(prev - FONT_SIZE_STEP, MIN_FONT_SIZE))
            }
            // Cmd/Ctrl + 0 (기본 크기로 리셋)
            else if (key === '0') {
                setTerminalFontSize(14)  // 기본 폰트 크기
            }
        })

        return cleanup
    }, [])

    const handleOnboardingComplete = () => {
        setShowOnboarding(false)
        setSettings(prev => ({ ...prev, hasCompletedOnboarding: true }))
    }

    const handleLicenseVerify = async (key: string, isFreeMode?: boolean): Promise<boolean> => {
        // Mark license screen as completed (won't show again)
        const markCompleted = async () => {
            const currentSettings = await window.api.getSettings()
            await window.api.saveSettings({
                ...currentSettings,
                licenseScreenCompleted: true
            })
            setSettings(prev => ({ ...prev, licenseScreenCompleted: true }))
        }

        if (isFreeMode) {
            // Continue with free plan
            const infoResult = await window.api.licenseGetInfo()
            if (infoResult.success && infoResult.data) {
                setLicenseInfo(infoResult.data)
            }
            await markCompleted()
            setShowLicenseVerification(false)
            return true
        }

        // Activate license with key
        const result = await window.api.licenseActivate(key)
        if (result.success) {
            // Refresh license info
            const infoResult = await window.api.licenseGetInfo()
            if (infoResult.success && infoResult.data) {
                setLicenseInfo(infoResult.data)
            }
            await markCompleted()
            setShowLicenseVerification(false)
            return true
        }
        return false
    }

    // Load license info on mount
    const loadLicenseInfo = async () => {
        const result = await window.api.licenseGetInfo()
        if (result.success && result.data) {
            setLicenseInfo(result.data)
        }
    }

    const handleSelect = (workspace: Workspace, session: TerminalSession) => {
        // If in split view, replace the active pane's session
        if (splitLayout && splitLayout.sessionIds.length > 0) {
            const sessionIds = [...splitLayout.sessionIds]

            // If the session is already in split view, just set it as active
            const existingIndex = sessionIds.indexOf(session.id)
            if (existingIndex >= 0) {
                setActiveSplitIndex(existingIndex)
            } else {
                // Replace the active pane's session
                sessionIds[activeSplitIndex] = session.id
                setSplitLayout({ ...splitLayout, sessionIds })
            }

            // Reset status for this session
            setSessionStatuses(prev => {
                const next = new Map(prev)
                const current = next.get(session.id)
                if (current) {
                    next.set(session.id, { ...current, status: 'idle' })
                }
                return next
            })
            return
        }

        // Single view mode
        setActiveWorkspace(workspace)
        setActiveSession(session)
        // 세션 선택 시 상태 초기화 (사용자가 확인했으므로 idle로 리셋)
        setSessionStatuses(prev => {
            const next = new Map(prev)
            const current = next.get(session.id)
            if (current) {
                next.set(session.id, { ...current, status: 'idle' })
            }
            return next
        })
    }

    // Handle session status change from Claude Code hooks
    const handleSessionStatusChange = (sessionId: string, status: SessionStatus, isClaudeCode: boolean) => {
        // Detect Claude Code exit: isClaudeCode was true, now false → clear CLI session info
        const wasClaudeCode = prevClaudeCodeRef.current.get(sessionId) ?? false
        if (wasClaudeCode && !isClaudeCode) {
            // Find workspace for this session and clear CLI info
            for (const ws of workspaces) {
                const session = ws.sessions.find(s => s.id === sessionId)
                if (session?.cliSessionId) {
                    window.api.clearSessionCliInfo(ws.id, sessionId)
                    setWorkspaces(prev => prev.map(w => {
                        if (w.id !== ws.id) return w
                        return {
                            ...w,
                            sessions: w.sessions.map(s => {
                                if (s.id !== sessionId) return s
                                const { cliSessionId: _, cliToolName: __, ...rest } = s
                                return rest as typeof s
                            })
                        }
                    }))
                    break
                }
            }
        }
        prevClaudeCodeRef.current.set(sessionId, isClaudeCode)

        setSessionStatuses(prev => {
            const next = new Map(prev)
            next.set(sessionId, { status, isClaudeCode })
            return next
        })
    }

    // ============================================
    // Split Terminal View Handlers
    // ============================================

    // Handle drag over the terminal area for split view
    const handleTerminalAreaDragOver = (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes('application/x-session-id')) return
        e.preventDefault()
        setDragOverZone('split')
    }

    const handleTerminalAreaDragLeave = () => {
        setDragOverZone(null)
    }

    // Handle drop on terminal area to add to split view
    const handleTerminalAreaDrop = async (e: React.DragEvent) => {
        e.preventDefault()
        setDragOverZone(null)

        const sessionId = e.dataTransfer.getData('application/x-session-id')
        if (!sessionId) return

        // Don't add if already in split
        if (splitLayout?.sessionIds.includes(sessionId)) return

        // Max 4 terminals in split
        if (splitLayout && splitLayout.sessionIds.length >= 4) return

        // Check license for new split view (not when adding to existing split)
        if (!splitLayout && !licenseInfo.limits.splitViewEnabled) {
            const { response } = await window.api.showMessageBox({
                type: 'info',
                title: 'Upgrade to Pro',
                message: 'Split View is a Pro feature. Upgrade to unlock split terminal view.',
                buttons: ['Later', 'Upgrade']
            })
            if (response === 1) {
                window.api.openExternal('https://www.solhun.com/pricing')
            }
            return
        }

        if (splitLayout) {
            // Add to existing split
            setSplitLayout({
                ...splitLayout,
                sessionIds: [...splitLayout.sessionIds, sessionId],
                sizes: undefined // Reset sizes to auto-calculate
            })
        } else if (activeSession) {
            // Start new split: current active session + dropped session
            setSplitLayout({
                sessionIds: [activeSession.id, sessionId]
            })
            setActiveSession(null)
        } else {
            // No active session, just add to split
            setSplitLayout({
                sessionIds: [sessionId]
            })
        }
    }

    // Handle removing a session from split view
    const handleRemoveFromSplit = (sessionId: string) => {
        if (!splitLayout) return

        const removedIndex = splitLayout.sessionIds.indexOf(sessionId)
        const newSessionIds = splitLayout.sessionIds.filter(id => id !== sessionId)

        if (newSessionIds.length <= 1) {
            // Return to single view mode
            if (newSessionIds.length === 1) {
                // Find the remaining session and make it active
                for (const workspace of workspaces) {
                    const session = workspace.sessions?.find(s => s.id === newSessionIds[0])
                    if (session) {
                        setActiveWorkspace(workspace)
                        setActiveSession(session)
                        break
                    }
                }
            }
            setSplitLayout(null)
            setActiveSplitIndex(0)
        } else {
            // Update split layout
            setSplitLayout({
                ...splitLayout,
                sessionIds: newSessionIds,
                sizes: undefined // Reset sizes
            })
            // Adjust active index if needed
            if (activeSplitIndex >= newSessionIds.length) {
                setActiveSplitIndex(newSessionIds.length - 1)
            } else if (removedIndex <= activeSplitIndex && activeSplitIndex > 0) {
                setActiveSplitIndex(activeSplitIndex - 1)
            }
        }
    }

    // Handle layout change (resize)
    const handleSplitLayoutChange = (layout: SplitTerminalLayout) => {
        setSplitLayout(layout)
    }

    // Handle reorder within split view
    const handleSplitReorder = (fromSessionId: string, toSessionId: string) => {
        if (!splitLayout) return

        const sessionIds = [...splitLayout.sessionIds]
        const fromIndex = sessionIds.indexOf(fromSessionId)
        const toIndex = sessionIds.indexOf(toSessionId)

        if (fromIndex === -1 || toIndex === -1) return

        // Swap positions
        sessionIds[fromIndex] = toSessionId
        sessionIds[toIndex] = fromSessionId

        setSplitLayout({
            ...splitLayout,
            sessionIds
        })
    }

    // Sync split layout to Grid Window (one-way: main → grid)
    useEffect(() => {
        if (splitLayout && splitLayout.sessionIds.length > 0) {
            window.api.syncGridSessions(splitLayout.sessionIds)
        }
    }, [splitLayout?.sessionIds.join(',')])

    // Handle drag start from sidebar
    const dragSafetyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    const handleSidebarDragStart = (sessionId: string) => {
        setIsDraggingSession(true)

        // Safety: auto-reset after 3s if dragEnd never fires (browser bug, focus loss, etc.)
        if (dragSafetyTimerRef.current) clearTimeout(dragSafetyTimerRef.current)
        dragSafetyTimerRef.current = setTimeout(() => {
            setIsDraggingSession(false)
            setDragOverZone(null)
        }, 3000)
    }

    const handleSidebarDragEnd = () => {
        setIsDraggingSession(false)
        setDragOverZone(null)
        if (dragSafetyTimerRef.current) clearTimeout(dragSafetyTimerRef.current)
    }

    // Fallback: document-level dragend to catch missed events
    useEffect(() => {
        const handleDocumentDragEnd = () => {
            setIsDraggingSession(false)
            setDragOverZone(null)
            if (dragSafetyTimerRef.current) clearTimeout(dragSafetyTimerRef.current)
        }
        document.addEventListener('dragend', handleDocumentDragEnd)
        return () => document.removeEventListener('dragend', handleDocumentDragEnd)
    }, [])

    // Handle opening search for a specific workspace (from split pane)
    const handleOpenSearchForWorkspace = (workspacePath: string) => {
        // Find workspace by path
        const workspace = workspaces.find(w => w.path === workspacePath)
        if (workspace) {
            setActiveWorkspace(workspace)
            setFileSearchOpen(true)
        }
    }

    // Handle opening git panel for a specific workspace (from split pane)
    const handleOpenGitForWorkspace = (workspacePath: string) => {
        // Find workspace by path and set as active
        const workspace = workspaces.find(w => w.path === workspacePath)
        if (workspace) {
            setActiveWorkspace(workspace)
            setGitPanelOpen(true)
        }
    }

    const refreshWorkspacesFromStore = async () => {
        const updatedWorkspaces = await window.api.getWorkspaces()
        const loadedFolders = await window.api.getFolders()
        setFolders(loadedFolders)
        const existingWorkspaceIds = new Set(updatedWorkspaces.map(w => w.id))

        // Never clear sessions on manual/interactive reload paths.
        setWorkspaces(updatedWorkspaces)

        setWorkspaceOrder(prev => prev.filter(id => existingWorkspaceIds.has(id)))
        setSessionOrders(prev => {
            const next = new Map<string, string[]>()
            for (const [workspaceId, sessionOrder] of prev.entries()) {
                const workspace = updatedWorkspaces.find(w => w.id === workspaceId)
                if (!workspace) continue

                const existingSessionIds = new Set(workspace.sessions.map(s => s.id))
                next.set(workspaceId, sessionOrder.filter(id => existingSessionIds.has(id)))
            }
            return next
        })

        setActiveWorkspace(prev => {
            if (!prev) return null
            return updatedWorkspaces.find(w => w.id === prev.id) || null
        })
        setActiveSession(prev => {
            if (!prev) return null
            for (const workspace of updatedWorkspaces) {
                const matched = workspace.sessions.find(s => s.id === prev.id)
                if (matched) return matched
            }
            return null
        })
    }

    const handleReloadWorktrees = async () => {
        const syncResult = await window.api.syncWorktreeWorkspaces()
        if (!syncResult.success) {
            throw new Error(syncResult.error || 'Failed to sync worktrees')
        }
        await refreshWorkspacesFromStore()
    }

    const handleAddWorkspace = async () => {
        const result = await window.api.addWorkspace()
        if (!result) return // User cancelled dialog

        if (result.success && result.data) {
            setWorkspaces(prev => [...prev, result.data!])
            // Add to workspace order if it's a regular workspace
            const newWorkspace = result.data
            if (!newWorkspace.isPlayground && !newWorkspace.parentWorkspaceId && !newWorkspace.isHome) {
                setWorkspaceOrder(prev => [...prev, newWorkspace.id])
            }
        } else if (result.errorType === 'UPGRADE_REQUIRED') {
            const { response } = await window.api.showMessageBox({
                type: 'info',
                title: 'Upgrade to Pro',
                message: result.error || 'Please upgrade to Pro to add more workspaces.',
                detail: 'Visit https://www.solhun.com/pricing for more details',
                buttons: ['Later', 'Upgrade']
            })

            if (response === 1) {
                // Open pricing page in external browser
                window.api.openExternal('https://www.solhun.com/pricing')
            }
        }
    }

    const handleRemoveWorkspace = async (id: string) => {
        setConfirmationModal({
            isOpen: true,
            title: 'Delete Workspace',
            message: 'Are you sure you want to delete this workspace? This action cannot be undone.',
            onConfirm: async () => {
                await window.api.removeWorkspace(id)
                setWorkspaces(prev => prev.filter(w => w.id !== id))
                // Remove from workspace order as well
                setWorkspaceOrder(prev => prev.filter(wid => wid !== id))
                // Remove from session orders as well
                setSessionOrders(prev => {
                    const next = new Map(prev)
                    next.delete(id)
                    return next
                })
                if (activeWorkspace?.id === id) {
                    setActiveWorkspace(null)
                    setActiveSession(null)
                }
            }
        })
    }

    const handleRenameSession = async (workspaceId: string, sessionId: string, newName: string) => {
        const success = await window.api.renameSession(workspaceId, sessionId, newName)
        if (success) {
            setWorkspaces(prev => prev.map(w => {
                if (w.id === workspaceId) {
                    return {
                        ...w,
                        sessions: w.sessions.map(s =>
                            s.id === sessionId ? { ...s, name: newName } : s
                        )
                    }
                }
                return w
            }))
        }
    }

    // Debounce timers for reorder IPC saves
    // Prevents rapid electron-store writes during drag (onReorder fires every pointer move)
    const sessionReorderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    const workspaceReorderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

    // 세션 순서 변경 핸들러
    // Note: workspaces 상태를 변경하지 않고 sessionOrders만 변경하여 터미널 재렌더링 방지
    const handleReorderSessions = (workspaceId: string, sessions: TerminalSession[]) => {
        const sessionIds = sessions.map(s => s.id)

        // 1. sessionOrders만 업데이트 (workspaces는 건드리지 않음 → 터미널 영향 없음)
        setSessionOrders(prev => {
            const next = new Map(prev)
            next.set(workspaceId, sessionIds)
            return next
        })

        // 2. Debounced save - only persist after drag settles (300ms after last reorder event)
        if (sessionReorderTimerRef.current) clearTimeout(sessionReorderTimerRef.current)
        sessionReorderTimerRef.current = setTimeout(() => {
            window.api.reorderSessions(workspaceId, sessionIds)
        }, 300)
    }

    // Sorted workspaces for Sidebar display (does NOT affect terminal rendering)
    // This keeps workspace array stable while only changing display order
    // Also sorts sessions within each workspace according to sessionOrders
    const sortedWorkspaces = useMemo(() => {
        // Helper function to sort sessions within a workspace
        const sortSessions = (workspace: Workspace): Workspace => {
            const order = sessionOrders.get(workspace.id)
            if (!order || !workspace.sessions) return workspace

            const sortedSessions = order
                .map(id => workspace.sessions.find(s => s.id === id))
                .filter((s): s is TerminalSession => s !== undefined)

            // Add any new sessions not in order yet
            const newSessions = workspace.sessions.filter(s => !order.includes(s.id))

            return { ...workspace, sessions: [...sortedSessions, ...newSessions] }
        }

        const homeWorkspace = workspaces.find(w => w.isHome)
        const playgroundWorkspaces = workspaces.filter(w => w.isPlayground)
        const worktreeWorkspaces = workspaces.filter(w => w.parentWorkspaceId)

        // Sort regular workspaces by workspaceOrder
        const regularWorkspaces = workspaceOrder
            .map(id => workspaces.find(w => w.id === id))
            .filter((w): w is Workspace => w !== undefined)

        // Add any new regular workspaces not in order yet
        const regularInWorkspaces = workspaces.filter(w => !w.isPlayground && !w.parentWorkspaceId && !w.isHome)
        const newRegular = regularInWorkspaces.filter(w => !workspaceOrder.includes(w.id))

        // Apply session sorting to all workspaces
        return [
            ...(homeWorkspace ? [sortSessions(homeWorkspace)] : []),
            ...regularWorkspaces.map(sortSessions),
            ...newRegular.map(sortSessions),
            ...worktreeWorkspaces.map(sortSessions),
            ...playgroundWorkspaces.map(sortSessions)
        ]
    }, [workspaces, workspaceOrder, sessionOrders])

    // Toggle pin state for a workspace
    const handleTogglePin = async (workspaceId: string) => {
        const newPinned = await window.api.togglePinWorkspace(workspaceId)
        setWorkspaces(prev => prev.map(w =>
            w.id === workspaceId ? { ...w, isPinned: newPinned } : w
        ))
    }

    // Folder handlers
    const handleCreateFolder = async (name: string) => {
        const newFolder = await window.api.createFolder(name)
        setFolders(prev => [...prev, newFolder])
    }

    const handleRenameFolder = async (folderId: string, newName: string) => {
        await window.api.renameFolder(folderId, newName)
        setFolders(prev => prev.map(f =>
            f.id === folderId ? { ...f, name: newName } : f
        ))
    }

    const handleRemoveFolder = async (folderId: string) => {
        await window.api.removeFolder(folderId)
        setFolders(prev => prev.filter(f => f.id !== folderId))
        // Workspaces in this folder become unfoldered
        setWorkspaces(prev => prev.map(w =>
            w.folderId === folderId ? { ...w, folderId: undefined } : w
        ))
    }

    const handleToggleFolderExpanded = async (folderId: string) => {
        const newExpanded = await window.api.toggleFolderExpanded(folderId)
        setFolders(prev => prev.map(f =>
            f.id === folderId ? { ...f, isExpanded: newExpanded } : f
        ))
    }

    const handleMoveWorkspaceToFolder = async (workspaceId: string, folderId: string | null) => {
        await window.api.moveWorkspaceToFolder(workspaceId, folderId)
        setWorkspaces(prev => prev.map(w =>
            w.id === workspaceId ? { ...w, folderId: folderId || undefined } : w
        ))
    }

    // Workspace order change handler - only changes display order, NOT workspaces array
    const handleReorderWorkspaces = (newWorkspaces: Workspace[]) => {
        const newOrder = newWorkspaces.map(w => w.id)

        // Only update display order, workspaces array stays unchanged
        setWorkspaceOrder(newOrder)

        // Debounced save - only persist after drag settles
        if (workspaceReorderTimerRef.current) clearTimeout(workspaceReorderTimerRef.current)
        workspaceReorderTimerRef.current = setTimeout(() => {
            window.api.reorderWorkspaces(newOrder)
        }, 300)
    }

    const handleAddSession = async (workspaceId: string, type: 'regular' | 'worktree' = 'regular', branchName?: string, initialCommand?: string, sessionName?: string) => {
        const result = await window.api.addSession(workspaceId, type, branchName, initialCommand, sessionName)
        if (!result) return

        if (result.success && result.data) {
            const newSession = result.data
            setWorkspaces(prev => {
                const updated = prev.map(w => {
                    if (w.id === workspaceId) {
                        return { ...w, sessions: [...w.sessions, newSession] }
                    }
                    return w
                })
                // Auto-select the new session
                const workspace = updated.find(w => w.id === workspaceId)
                if (workspace) {
                    setActiveWorkspace(workspace)
                    setActiveSession(newSession)
                }
                return updated
            })
            // Update sessionOrders to include new session
            setSessionOrders(prev => {
                const next = new Map(prev)
                const currentOrder = next.get(workspaceId) || []
                next.set(workspaceId, [...currentOrder, newSession.id])
                return next
            })
        } else if (result.errorType === 'UPGRADE_REQUIRED') {
            const { response } = await window.api.showMessageBox({
                type: 'info',
                title: 'Upgrade to Pro',
                message: result.error || 'Please upgrade to Pro to add more sessions.',
                detail: 'Visit https://www.solhun.com/pricing for more details',
                buttons: ['Later', 'Upgrade']
            })

            if (response === 1) {
                window.api.openExternal('https://www.solhun.com/pricing')
            }
        }
    }

    // Handle clearing terminal buffer (Cmd+K)
    const handleClearSession = (sessionId: string) => {
        window.api.clearTerminal(sessionId)
    }

    // Handle closing session and navigating to previous (Cmd+W)
    const handleCloseSession = async (workspaceId: string, sessionId: string) => {
        const workspace = workspaces.find(w => w.id === workspaceId)
        if (!workspace) return

        const sessions = workspace.sessions
        const currentIndex = sessions.findIndex(s => s.id === sessionId)

        // Determine which session to select after closing
        let nextSession: TerminalSession | null = null
        if (sessions.length > 1) {
            // Prefer previous session, fallback to next
            if (currentIndex > 0) {
                nextSession = sessions[currentIndex - 1]
            } else {
                nextSession = sessions[currentIndex + 1]
            }
        }

        // Navigate to next session first using handleSelect for proper UI sync
        if (nextSession) {
            handleSelect(workspace, nextSession)
        } else {
            setActiveWorkspace(workspace)
            setActiveSession(null)
        }

        // Then remove the session (skip confirmation dialog for keyboard shortcut)
        await handleRemoveSession(workspaceId, sessionId, true)
    }

    // Centralized keyboard shortcuts (session/workspace navigation, search, sidebar, settings, etc.)
    useKeyboardShortcuts({
        settings,
        activeWorkspace,
        activeSession,
        sortedWorkspaces,
        splitLayout,
        activeSplitIndex,
        settingsOpen,
        fileSearchOpen,
        templates: customTemplates,
        onSelectSession: handleSelect,
        onSetActiveSplitIndex: setActiveSplitIndex,
        onSetFileSearchOpen: setFileSearchOpen,
        onSetFileSearchMode: setFileSearchMode,
        onToggleSidebar: () => setIsSidebarOpen(prev => !prev),
        onToggleSettings: () => setSettingsOpen(prev => !prev),
        onAddSession: (workspaceId, template) => {
            handleAddSession(workspaceId, 'regular', undefined, template?.command, template?.name)
        },
        onCloseSession: handleCloseSession,
        onClearSession: handleClearSession,
        onRenameSession: (sessionId: string) => {
            // Dispatch custom event to Sidebar
            window.dispatchEvent(new CustomEvent('rename-session-request', { detail: { sessionId } }))
        },
    })

    const handleAddWorktreeWorkspace = async (parentWorkspaceId: string, branchName: string) => {
        const result: IPCResult<Workspace> = await window.api.addWorktreeWorkspace(parentWorkspaceId, branchName)

        if (result.success && result.data) {
            setWorkspaces(prev => [...prev, result.data!])
        } else if (result.errorType === 'UPGRADE_REQUIRED') {
            const { response } = await window.api.showMessageBox({
                type: 'info',
                title: 'Upgrade to Pro',
                message: result.error || 'Git Worktree is a Pro feature. Upgrade to unlock.',
                detail: 'Visit https://www.solhun.com/pricing for more details',
                buttons: ['Later', 'Upgrade']
            })

            if (response === 1) {
                window.api.openExternal('https://www.solhun.com/pricing')
            }
        } else {
            await window.api.showMessageBox({
                type: 'error',
                title: 'Worktree Creation Failed',
                message: getErrorMessage(result.errorType, result.error),
                buttons: ['OK']
            })
        }
    }

    const handleRemoveSession = async (workspaceId: string, sessionId: string, skipConfirm?: boolean) => {
        // Check if there are running processes (skip if already confirmed)
        if (!skipConfirm) {
            const hasRunning = await window.api.hasRunningProcess(sessionId)

            if (hasRunning) {
                // Ask for confirmation only if processes are running
                const { response } = await window.api.showMessageBox({
                    type: 'warning',
                    title: 'Terminate Session',
                    message: 'Do you want to terminate running processes?',
                    buttons: ['Cancel', 'Terminate']
                })

                // Cancel clicked
                if (response === 0) return
            }
        }

        // Kill the terminal process
        await window.api.killTerminal(sessionId)

        // Remove from store
        await window.api.removeSession(workspaceId, sessionId)

        // Update UI
        setWorkspaces(prev => prev.map(w => {
            if (w.id === workspaceId) {
                return { ...w, sessions: w.sessions.filter(s => s.id !== sessionId) }
            }
            return w
        }))

        // Update sessionOrders to remove deleted session
        setSessionOrders(prev => {
            const next = new Map(prev)
            const currentOrder = next.get(workspaceId)
            if (currentOrder) {
                next.set(workspaceId, currentOrder.filter(id => id !== sessionId))
            }
            return next
        })

        // Clear active session if it's the one being removed
        // Skip if skipConfirm is true (called from handleCloseSession which already set the next session)
        if (!skipConfirm && activeSession?.id === sessionId) {
            setActiveSession(null)
        }
    }

    const handleCreatePlayground = async () => {
        const newWorkspace = await window.api.createPlayground()
        if (newWorkspace) {
            setWorkspaces(prev => [...prev, newWorkspace])
        }
    }

    const handleOpenInEditor = async (workspacePath: string) => {
        try {
            const result = await window.api.openInEditor(workspacePath)
            if (!result.success) {
                console.error('Failed to open in editor:', result.error)
            }
        } catch (error) {
            console.error('Failed to open in editor:', error)
        }
    }

    const handleFileSelect = async (filePath: string, line?: number) => {
        if (!activeWorkspace) return

        try {
            const result = await window.api.openFileInEditor(filePath, activeWorkspace.path, line)
            if (!result.success) {
                console.error('Failed to open file in editor:', result.error)
            }
        } catch (error) {
            console.error('Failed to open file in editor:', error)
        }
    }

    const [settingsCategory, setSettingsCategory] = useState<any>('general')

    const logPortAction = async (action: 'kill' | 'ignore-port' | 'ignore-process', target: string, port?: number, details?: string) => {
        const newLog: PortActionLog = {
            timestamp: Date.now(),
            action,
            target,
            port,
            details
        }
        
        const newSettings = {
            ...settings,
            portActionLogs: [...(settings.portActionLogs || []), newLog]
        }
        
        // We need to update settings state immediately to reflect changes in UI if needed,
        // but for logs we might want to be careful about state updates if they happen frequently.
        // However, these actions are user-triggered and infrequent enough.
        setSettings(newSettings)
        await window.api.saveSettings(newSettings)
        return newSettings
    }

    const handleIgnorePort = async (port: number) => {
        const newSettings = await logPortAction('ignore-port', port.toString(), port)

        const updatedSettings = {
            ...newSettings,
            ignoredPorts: [...(newSettings.ignoredPorts || []), port]
        }
        setSettings(updatedSettings)
        await window.api.saveSettings(updatedSettings)
    }

    const handleIgnoreProcess = async (processName: string, port: number) => {
        const newSettings = await logPortAction('ignore-process', processName, port)

        const updatedSettings = {
            ...newSettings,
            ignoredProcesses: [...(newSettings.ignoredProcesses || []), processName]
        }
        setSettings(updatedSettings)
        await window.api.saveSettings(updatedSettings)
    }

    const handleKillProcess = async (pid: number, port: number) => {
        await window.api.killProcess(pid)
        await logPortAction('kill', pid.toString(), port, 'Process terminated by user')
    }

    const handleSaveSettings = async (newSettings: UserSettings) => {
        // Compare using default values for proper comparison
        const oldShowHome = settings.showHomeWorkspace ?? true
        const newShowHome = newSettings.showHomeWorkspace ?? true
        const oldHomePath = settings.homeWorkspacePath ?? ''
        const newHomePath = newSettings.homeWorkspacePath ?? ''

        const homeSettingsChanged = oldShowHome !== newShowHome || oldHomePath !== newHomePath

        setSettings(newSettings)
        await window.api.saveSettings(newSettings)

        // Reload workspaces if home workspace settings changed
        if (homeSettingsChanged) {
            console.log('[Settings] Home workspace settings changed, reloading workspaces...')
            await refreshWorkspacesFromStore()
        }
    }

    const handleOpenSettings = (category: 'general' | 'port-monitoring') => {
        setSettingsCategory(category)
        setSettingsOpen(true)
    }

    // Fullscreen mode renders only terminals
    if (isFullscreenMode) {
        return (
            <FullscreenTerminalView
                sessionIds={fullscreenSessionIds}
                terminalFontSize={terminalFontSize}
                terminalFontFamily={settings.terminalFontFamily}
                shell={settings.defaultShell}
                keyboardSettings={settings.keyboard}
                hooksSettings={settings.hooks}
            />
        )
    }

    return (
        <div className="flex h-screen w-screen bg-transparent">
            {showLicenseVerification && <LicenseVerification onVerify={handleLicenseVerify} />}
            {!showLicenseVerification && showOnboarding && <Onboarding onComplete={handleOnboardingComplete} />}

            {isSidebarOpen && (
                <Sidebar
                    workspaces={sortedWorkspaces}
                    onSelect={handleSelect}
                    onAddWorkspace={handleAddWorkspace}
                    onRemoveWorkspace={handleRemoveWorkspace}
                    onAddSession={handleAddSession}
                    onAddWorktreeWorkspace={handleAddWorktreeWorkspace}
                    onRemoveSession={handleRemoveSession}
                    onCreatePlayground={handleCreatePlayground}
                    activeSessionId={activeSession?.id}
                    sessionStatuses={sessionStatuses}
                    hooksSettings={settings.hooks}
                    terminalPreview={settings.terminalPreview}
                    onOpenInEditor={handleOpenInEditor}
                    onReloadWorktrees={handleReloadWorktrees}
                    onOpenSettings={() => handleOpenSettings('general')}
                    settingsOpen={settingsOpen}
                    onRenameSession={handleRenameSession}
                    onReorderSessions={handleReorderSessions}
                    onReorderWorkspaces={handleReorderWorkspaces}
                    onTogglePin={handleTogglePin}
                    folders={folders}
                    onCreateFolder={handleCreateFolder}
                    onRenameFolder={handleRenameFolder}
                    onRemoveFolder={handleRemoveFolder}
                    onToggleFolderExpanded={handleToggleFolderExpanded}
                    onMoveWorkspaceToFolder={handleMoveWorkspaceToFolder}
                    width={sidebarWidth}
                    setWidth={setSidebarWidth}
                    onClose={() => setIsSidebarOpen(false)}
                    fontSize={settings.fontSize}
                    showSessionCount={settings.showSessionCount}
                    splitLayout={splitLayout}
                    onDragStartSession={handleSidebarDragStart}
                    onDragEndSession={handleSidebarDragEnd}
                />
            )}
            <div className="flex-1 glass-panel m-2 ml-0 rounded-lg overflow-hidden flex flex-col">
                {/* Header - minimized in split view */}
                <div className={`${splitLayout ? 'h-6' : 'h-10'} border-b border-white/10 flex items-center px-4 draggable justify-between relative z-10 transition-all`}>
                    <div className="flex items-center gap-2">
                        {!isSidebarOpen && (
                            <button
                                onClick={() => setIsSidebarOpen(true)}
                                className={`${splitLayout ? 'p-0.5' : 'p-1.5'} hover:bg-white/10 rounded transition-colors no-drag text-gray-400`}
                                title="Open Sidebar"
                            >
                                <PanelLeft size={splitLayout ? 14 : 16} />
                            </button>
                        )}
                        {/* Show workspace name only in single view */}
                        {!splitLayout && (
                            <span
                                className="text-gray-400"
                                style={{ fontSize: `${settings.fontSize}px` }}
                            >
                                {activeWorkspace ? activeWorkspace.name : 'Select a workspace to get started'}
                            </span>
                        )}
                    </div>
                    <div className="flex items-center gap-2 no-drag">
                        {/* Single view buttons - hidden in split view (each pane has its own) */}
                        {!splitLayout && (
                            <>
                                <button
                                    onClick={() => {
                                        if (activeWorkspace) {
                                            setFileSearchOpen(true)
                                        }
                                    }}
                                    className="p-2 hover:bg-white/10 rounded transition-colors no-drag disabled:opacity-50 disabled:cursor-not-allowed"
                                    title="Search Files (Cmd+P)"
                                    disabled={!activeWorkspace}
                                >
                                    <Search size={16} className="text-gray-400" />
                                </button>
                                <button
                                    onClick={() => setGitPanelOpen(true)}
                                    className="p-2 hover:bg-white/10 rounded transition-colors no-drag"
                                    title="Source Control"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
                                        <line x1="6" y1="3" x2="6" y2="15"></line>
                                        <circle cx="18" cy="6" r="3"></circle>
                                        <circle cx="6" cy="18" r="3"></circle>
                                        <path d="M18 9a9 9 0 0 1-9 9"></path>
                                    </svg>
                                </button>
                                <button
                                    ref={monitorButtonRef}
                                    onClick={() => setShowMonitor(prev => !prev)}
                                    className={`p-2 hover:bg-white/10 rounded transition-colors no-drag ${showMonitor ? 'bg-white/10' : ''}`}
                                    title="System Monitor"
                                >
                                    <Monitor size={16} className="text-gray-400" />
                                </button>
                                <button
                                    onClick={() => handleOpenSettings('general')}
                                    className="p-2 hover:bg-white/10 rounded transition-colors no-drag"
                                    title="Settings"
                                >
                                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-gray-400">
                                        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"></path>
                                        <circle cx="12" cy="12" r="3"></circle>
                                    </svg>
                                </button>
                            </>
                        )}
                        {/* Grid button removed - each split pane has its own */}
                    </div>
                </div>
                <div className="flex-1 pt-4 px-4 pb-0 flex flex-col overflow-hidden min-h-0">
                    {/* Terminal container with relative positioning for absolute children */}
                    <div
                        className="flex-1 relative overflow-hidden"
                        onDragOver={handleTerminalAreaDragOver}
                        onDragLeave={handleTerminalAreaDragLeave}
                        onDrop={handleTerminalAreaDrop}
                    >
                        {/* Drop zone - always present when dragging to capture events above terminal */}
                        {isDraggingSession && (
                            <div
                                className={`absolute inset-0 z-30 rounded-lg flex items-center justify-center transition-colors ${
                                    dragOverZone === 'split'
                                        ? 'bg-blue-500/10 border-2 border-dashed border-blue-500/50'
                                        : 'bg-transparent'
                                }`}
                                onDragOver={(e) => {
                                    if (!e.dataTransfer.types.includes('application/x-session-id')) return
                                    e.preventDefault()
                                    e.stopPropagation()
                                    setDragOverZone('split')
                                }}
                                onDragLeave={(e) => {
                                    e.stopPropagation()
                                    setDragOverZone(null)
                                }}
                                onDrop={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    handleTerminalAreaDrop(e)
                                }}
                            >
                                {dragOverZone === 'split' && (
                                    <div className="bg-blue-500/20 px-4 py-2 rounded-lg pointer-events-none">
                                        <span className="text-blue-300 text-sm font-medium">
                                            {splitLayout
                                                ? `Add to split view (${splitLayout.sessionIds.length}/4)`
                                                : 'Create split view'}
                                        </span>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* Split View Headers Only - z-20 to be above terminals */}
                        {splitLayout && splitLayout.sessionIds.length > 0 && (
                            <div className={`absolute inset-0 z-20 grid gap-2 pb-2 pointer-events-none ${
                                splitLayout.sessionIds.length === 2 ? 'grid-cols-2 grid-rows-1' :
                                splitLayout.sessionIds.length === 3 ? 'grid-cols-2 grid-rows-2' :
                                splitLayout.sessionIds.length === 4 ? 'grid-cols-2 grid-rows-2' :
                                'grid-cols-1 grid-rows-1'
                            }`}>
                                {splitLayout.sessionIds.map((sessionId, index) => {
                                    // Find session and workspace for header
                                    let foundSession: TerminalSession | undefined
                                    let foundWorkspace: Workspace | undefined
                                    for (const ws of workspaces) {
                                        const sess = ws.sessions?.find(s => s.id === sessionId)
                                        if (sess) {
                                            foundSession = sess
                                            foundWorkspace = ws
                                            break
                                        }
                                    }
                                    if (!foundSession) return null

                                    // For 3 terminals, make the third one span both columns
                                    const isThirdInThreeLayout = splitLayout.sessionIds.length === 3 && index === 2
                                    const gridClass = isThirdInThreeLayout ? 'col-span-2' : ''

                                    return (
                                        <div
                                            key={sessionId}
                                            className={`flex flex-col border border-white/10 rounded-lg overflow-hidden pointer-events-none ${gridClass}`}
                                        >
                                            {/* Header only - clickable */}
                                            <div className="pointer-events-auto">
                                                <SplitTerminalHeader
                                                    session={foundSession}
                                                    workspace={foundWorkspace}
                                                    isActive={index === activeSplitIndex}
                                                    onRemove={handleRemoveFromSplit}
                                                    onOpenSearch={handleOpenSearchForWorkspace}
                                                    onOpenGit={handleOpenGitForWorkspace}
                                                    onOpenSettings={() => handleOpenSettings('general')}
                                                    onOpenFullscreen={() => {
                                                        if (splitLayout) {
                                                            window.api.openFullscreenTerminal(splitLayout.sessionIds)
                                                        }
                                                    }}
                                                    onPaneClick={() => setActiveSplitIndex(index)}
                                                    onReorder={handleSplitReorder}
                                                />
                                            </div>
                                            {/* Terminal placeholder - clicks pass through to terminal below */}
                                            <div className="flex-1" data-terminal-slot={sessionId} />
                                        </div>
                                    )
                                })}
                            </div>
                        )}

                    {/* ALL terminals - ALWAYS rendered to prevent unmount/remount */}
                    {workspaces.map(workspace => (
                        workspace.sessions?.map(session => {
                            const splitIndex = splitLayout?.sessionIds.indexOf(session.id) ?? -1
                            const isInSplit = splitIndex >= 0
                            const isActive = activeSession?.id === session.id
                            // Visible if: in split view, OR (no split and is active session)
                            const isVisible = isInSplit || (!splitLayout && isActive)

                            // Calculate position for split view
                            // Uses top/bottom positioning instead of height for responsive vertical resize
                            const getSplitStyle = (): React.CSSProperties => {
                                if (!isInSplit || !splitLayout) {
                                    // Single view: absolute positioning with top/bottom for responsive height
                                    return {
                                        display: isVisible ? 'block' : 'none',
                                        position: 'absolute',
                                        top: 0,
                                        left: 0,
                                        right: 0,
                                        bottom: 0
                                    }
                                }

                                const count = splitLayout.sessionIds.length
                                const idx = splitIndex

                                // Calculate grid position with padding for breathing room
                                const gap = 8 // gap between terminals (gap-2)
                                const headerHeight = 32 // h-8 = 32px
                                const bottomPadding = 8 // extra space at bottom

                                // Use top/bottom for vertical positioning (responsive to parent height)
                                // Use left/right for horizontal positioning (responsive to parent width)
                                let top = '0px'
                                let bottom = `${bottomPadding}px`
                                let left = '0px'
                                let right = '0px'

                                if (count === 2) {
                                    // Side by side: each takes half width
                                    if (idx === 0) {
                                        right = `calc(50% + ${gap / 2}px)`
                                    } else {
                                        left = `calc(50% + ${gap / 2}px)`
                                    }
                                } else if (count === 3) {
                                    if (idx < 2) {
                                        // Top row: two terminals side by side
                                        bottom = `calc(50% + ${gap / 2}px)`
                                        if (idx === 0) {
                                            right = `calc(50% + ${gap / 2}px)`
                                        } else {
                                            left = `calc(50% + ${gap / 2}px)`
                                        }
                                    } else {
                                        // Bottom row (spans full width)
                                        top = `calc(50% + ${gap / 2}px)`
                                        bottom = `${bottomPadding}px`
                                    }
                                } else if (count === 4) {
                                    // 2x2 grid
                                    if (idx < 2) {
                                        // Top row
                                        bottom = `calc(50% + ${gap / 2}px)`
                                    } else {
                                        // Bottom row
                                        top = `calc(50% + ${gap / 2}px)`
                                        bottom = `${bottomPadding}px`
                                    }
                                    if (idx % 2 === 0) {
                                        // Left column
                                        right = `calc(50% + ${gap / 2}px)`
                                    } else {
                                        // Right column
                                        left = `calc(50% + ${gap / 2}px)`
                                    }
                                }

                                return {
                                    position: 'absolute',
                                    top,
                                    bottom,
                                    left,
                                    right,
                                    paddingTop: `${headerHeight}px`, // Account for header
                                    display: 'block'
                                }
                            }

                            // Check if this session is in grid view
                            const isInGridView = gridViewSessionIds.includes(session.id)

                            return (
                                <div
                                    key={session.id}
                                    style={getSplitStyle()}
                                >
                                    <div className="h-full w-full relative">
                                        {/* Show overlay when session is in grid view */}
                                        {isInGridView && isVisible && (
                                            <div className="absolute inset-0 z-50 bg-black flex flex-col items-center justify-center gap-4">
                                                <LayoutGrid size={48} className="text-gray-500" />
                                                <p className="text-gray-400 text-sm">Viewing in Grid Window</p>
                                                <p className="text-gray-500 text-xs">Close Grid Window to view here</p>
                                            </div>
                                        )}
                                        <TerminalView
                                            id={session.id}
                                            cwd={session.cwd}
                                            visible={isVisible && !isInGridView}
                                            onSessionStatusChange={handleSessionStatusChange}
                                            onFocus={(sessionId) => {
                                                // Update active split pane when terminal gains focus
                                                if (splitLayout) {
                                                    const index = splitLayout.sessionIds.indexOf(sessionId)
                                                    if (index >= 0) {
                                                        setActiveSplitIndex(index)
                                                    }
                                                }
                                            }}
                                            fontSize={terminalFontSize}
                                            fontFamily={settings.terminalFontFamily}
                                            initialCommand={session.initialCommand}
                                            resumeCommand={session.cliSessionId && session.cliToolName
                                                ? `${session.cliToolName === 'claude' ? 'claude' : session.cliToolName} --resume ${session.cliSessionId}`
                                                : undefined}
                                            workspaceId={workspace.id}
                                            shell={settings.defaultShell}
                                            keyboardSettings={settings.keyboard}
                                            hooksSettings={settings.hooks}
                                            disablePtyResize={isInGridView}
                                        />
                                        <SessionMemo
                                            sessionId={session.id}
                                            workspaceId={workspace.id}
                                            initialMemo={session.memo}
                                            visible={isVisible && !isInGridView}
                                        />
                                    </div>
                                </div>
                            )
                        })
                    ))}

                        {!activeSession && !splitLayout && (
                            <div className="h-full flex flex-col items-center justify-center text-gray-500">
                                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded mb-4">
                                    <p className="text-xs text-blue-200">
                                        <strong>Tip:</strong> If the terminal seems frozen, try pressing Enter
                                    </p>
                                </div>
                                please select a terminal

                                {settings.feedbackEmail && (
                                    <button
                                        onClick={async () => {
                                            const version = await window.api.getAppVersion()
                                            const subject = encodeURIComponent('[CLImanger] Issue Report')
                                            const body = encodeURIComponent(
                                                `\n\n---\nApp Version: ${version}\nOS: ${navigator.platform}`
                                            )
                                            window.api.openExternal(
                                                `mailto:${settings.feedbackEmail}?subject=${subject}&body=${body}`
                                            )
                                        }}
                                        className="mt-6 flex items-center gap-2 px-3 py-1.5 text-xs text-gray-400 hover:text-white bg-white/5 hover:bg-white/10 border border-white/10 rounded transition-colors"
                                    >
                                        <MessageSquare size={14} />
                                        Report Issue
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </div>
                <StatusBar 
                    portFilter={settings.portFilter} 
                    ignoredPorts={settings.ignoredPorts}
                    ignoredProcesses={settings.ignoredProcesses}
                    onIgnorePort={handleIgnorePort}
                    onIgnoreProcess={handleIgnoreProcess}
                    onKillProcess={handleKillProcess}
                    onOpenSettings={() => handleOpenSettings('port-monitoring')}
                />
            </div>

            {/* System Monitor Popover */}
            {showMonitor && (
                <SystemMonitorPopover
                    anchorRef={monitorButtonRef}
                    onClose={() => setShowMonitor(false)}
                />
            )}

            {/* Settings Modal */}
            <Settings
                isOpen={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                onSave={handleSaveSettings}
                initialCategory={settingsCategory}
                onResetOnboarding={() => {
                    setShowOnboarding(true)
                    setSettings(prev => ({ ...prev, hasCompletedOnboarding: false }))
                }}
                licenseInfo={licenseInfo}
                onLicenseChange={setLicenseInfo}
            />

            {/* Git Panel */}
            <GitPanel
                workspacePath={activeWorkspace?.path}
                isOpen={gitPanelOpen}
                onClose={() => setGitPanelOpen(false)}
            />

            {/* Confirmation Modal */}
            {confirmationModal.isOpen && (
                <ConfirmationModal
                    title={confirmationModal.title}
                    message={confirmationModal.message}
                    onConfirm={() => {
                        confirmationModal.onConfirm()
                        setConfirmationModal(prev => ({ ...prev, isOpen: false }))
                    }}
                    onCancel={() => setConfirmationModal(prev => ({ ...prev, isOpen: false }))}
                    isDangerous={true}
                    confirmText="Delete"
                />
            )}

            {/* Update Notification */}
            {showUpdateNotification && (
                <UpdateNotification
                    status={updateStatus}
                    version={updateVersion}
                    percent={updatePercent}
                    onDownload={() => {
                        setUpdateStatus('downloading')
                        window.api.downloadUpdate()
                    }}
                    onInstall={() => {
                        window.api.installUpdate()
                    }}
                    onLater={() => {
                        setShowUpdateNotification(false)
                    }}
                />
            )}

            {/* File Search */}
            <FileSearch
                isOpen={fileSearchOpen}
                onClose={() => setFileSearchOpen(false)}
                workspacePath={activeWorkspace?.path || null}
                onFileSelect={handleFileSelect}
                initialMode={fileSearchMode}
            />
        </div>
    )
}

export default App
