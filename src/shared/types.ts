export type NotificationStatus = 'none' | 'info' | 'error' | 'success' | 'warning'

// Session status for Claude Code monitoring (claude-squad 방식)
// idle: No activity detected / Claude Code not running
// running: Output being generated (화면이 변경됨)
// ready: Waiting for user input (출력이 멈춤)
// error: Error occurred
export type SessionStatus = 'idle' | 'running' | 'ready' | 'error'

export type EditorType = 'vscode' | 'cursor' | 'antigravity' | 'custom'

export type ErrorType =
    | 'GIT_NOT_FOUND'
    | 'NOT_A_REPO'
    | 'BRANCH_EXISTS'
    | 'INVALID_BRANCH_NAME'
    | 'WORKTREE_EXISTS'
    | 'GH_CLI_NOT_FOUND'
    | 'GH_NOT_AUTHENTICATED'
    | 'NETWORK_ERROR'
    | 'UNKNOWN_ERROR'
    | 'UPGRADE_REQUIRED'
    | 'LICENSE_EXPIRED'

// ============================================
// License & Pricing Types
// ============================================

export type PlanType = 'free' | 'monthly' | 'annual' | 'lifetime'

export type LicenseStatus = 'active' | 'expired' | 'disabled' | 'inactive'

export interface LicenseData {
    licenseKey: string
    instanceId: string
    activatedAt: string
    customerEmail?: string
    customerName?: string
    productName?: string
    // Plan information from Lemon Squeezy
    variantId?: number
    variantName?: string
    expiresAt?: string | null  // null for lifetime
    status?: LicenseStatus
    productId?: number
}

export interface FeatureLimits {
    maxWorkspaces: number        // -1 means unlimited
    maxSessionsPerWorkspace: number
    maxTemplates: number
    worktreeEnabled: boolean
    splitViewEnabled: boolean
    githubIntegrationEnabled: boolean
    portMonitoringEnabled: boolean
}

// Plan limits configuration
export const PLAN_LIMITS: Record<PlanType, FeatureLimits> = {
    free: {
        maxWorkspaces: 2,
        maxSessionsPerWorkspace: 5,
        maxTemplates: 3,
        worktreeEnabled: false,
        splitViewEnabled: false,
        githubIntegrationEnabled: true,  // GitHub is available for free
        portMonitoringEnabled: true,
    },
    monthly: {
        maxWorkspaces: -1,
        maxSessionsPerWorkspace: -1,
        maxTemplates: -1,
        worktreeEnabled: true,
        splitViewEnabled: true,
        githubIntegrationEnabled: true,
        portMonitoringEnabled: true,
    },
    annual: {
        maxWorkspaces: -1,
        maxSessionsPerWorkspace: -1,
        maxTemplates: -1,
        worktreeEnabled: true,
        splitViewEnabled: true,
        githubIntegrationEnabled: true,
        portMonitoringEnabled: true,
    },
    lifetime: {
        maxWorkspaces: -1,
        maxSessionsPerWorkspace: -1,
        maxTemplates: -1,
        worktreeEnabled: true,
        splitViewEnabled: true,
        githubIntegrationEnabled: true,
        portMonitoringEnabled: true,
    },
}

export interface LicenseInfo {
    planType: PlanType
    license: LicenseData | null
    limits: FeatureLimits
    isExpired: boolean
    daysUntilExpiry?: number
}

export interface IPCResult<T> {
    success: boolean
    data?: T
    error?: string
    errorType?: ErrorType
}

export interface TerminalSession {
    id: string
    name: string
    cwd: string
    type: 'regular' | 'worktree'
    notificationStatus?: NotificationStatus
    initialCommand?: string
    cliSessionId?: string
    cliToolName?: string
}

export interface TerminalTemplate {
    id: string
    name: string
    icon: string
    description: string
    command: string
    cwd?: string
}

export interface Workspace {
    id: string
    name: string
    path: string
    sessions: TerminalSession[]
    createdAt: number
    isPlayground?: boolean
    isHome?: boolean  // Home directory workspace (cannot be deleted)
    isPinned?: boolean  // Pin workspace to top of sidebar
    parentWorkspaceId?: string  // Worktree인 경우 부모 workspace ID
    branchName?: string  // Worktree의 브랜치명
    baseBranch?: string  // Worktree 생성 시 분기한 브랜치 (merge 대상)
}

export interface AppConfig {
    workspaces: Workspace[]
    playgroundPath: string
    settings?: UserSettings
    customTemplates?: TerminalTemplate[]
}

export interface UserSettings {
    theme: 'dark' | 'light'
    fontSize: number  // UI 요소(사이드바 파일/폴더명 등)에만 적용
    fontFamily?: string  // deprecated - 사용 안 함
    terminalFontFamily?: string  // Terminal font (e.g., 'MesloLGS NF', 'FiraCode Nerd Font')
    defaultShell: string
    defaultEditor: EditorType
    customEditorPath?: string  // Custom editor command or path
    portFilter?: {
        enabled: boolean
        minPort: number
        maxPort: number
    }
    github?: {
        username: string
        email: string
        isAuthenticated: boolean
    }
    notifications?: {
        enabled: boolean
        tools: {
            cc: boolean
            codex: boolean
            gemini: boolean
            generic: boolean
        }
    }
    ignoredPorts?: number[]
    ignoredProcesses?: string[]
    portActionLogs?: PortActionLog[]
    // Git Worktree 설정
    worktreePath?: string  // 커스텀 worktree 저장 경로 (없으면 기본 경로 사용)
    hasCompletedOnboarding?: boolean
    // Home Workspace 설정
    showHomeWorkspace?: boolean  // 홈 워크스페이스 표시 여부 (기본값: true)
    homeWorkspacePath?: string   // 커스텀 홈 워크스페이스 경로 (없으면 시스템 홈 디렉토리)
    // License 설정
    licenseScreenCompleted?: boolean  // 라이선스 화면 완료 여부 (true면 다시 안 보임)
    // Keyboard 설정
    keyboard?: {
        scrollShortcuts: boolean    // ⌘↑/⌘↓ 스크롤 단축키 활성화 (기본값: true)
        showScrollButtons: boolean  // 플로팅 스크롤 버튼 표시 (기본값: true)
        shortcuts?: KeyboardShortcutMap  // Configurable keyboard shortcuts (falls back to DEFAULT_SHORTCUTS)
    }
    // Session Count 설정 (워크스페이스 이름 옆에 세션 수 표시)
    showSessionCount?: boolean  // 기본값: false
    // Terminal Preview 설정 (hover 시 마지막 N줄 미리보기)
    terminalPreview?: {
        enabled: boolean            // 미리보기 활성화 (기본값: false)
        lineCount: number           // 표시할 줄 수 (기본값: 5, 최대 10)
    }
    // Hooks 설정 (Claude Code 세션 모니터링)
    hooks?: HooksSettings
    // Feedback email for issue reporting
    feedbackEmail?: string
}

// Hooks settings for AI tool session monitoring
// claude-squad 방식: 화면 변경 = Running, 변경 없음 = Ready
export interface HooksSettings {
    enabled: boolean                    // Master switch for hooks
    claudeCode: {
        enabled: boolean                // Enable Claude Code monitoring
        detectRunning: boolean          // Detect "Running" state (output being generated)
        detectReady: boolean            // Detect "Ready" state (output stopped)
        detectError: boolean            // Detect errors
        showInSidebar: boolean          // Show status indicator in sidebar
        autoDismissSeconds: number      // Auto-dismiss notification time (default: 5)
    }
    // Future: codex, gemini, etc.
}

export interface PortActionLog {
    timestamp: number
    action: 'kill' | 'ignore-port' | 'ignore-process'
    target: string
    port?: number  // 관련 포트 번호
    details?: string
}

export interface PortInfo {
    port: number
    pid: number
    command: string
    cwd?: string
}

// ============================================
// System Monitor Types
// ============================================

export interface SystemInfo {
    cpu: {
        model: string
        count: number
        usage: {
            user: number
            sys: number
            idle: number
            total: number
        }
    }
    memory: {
        totalGB: string
        usedGB: string
        freeGB: string
        usagePercent: number
    }
    disk: {
        total: string
        used: string
        available: string
        usagePercent: string
    }
    battery: {
        percent: number
        status: 'charging' | 'discharging' | 'charged' | 'unknown'
        powerSource: 'AC' | 'Battery'
    } | null
    uptime: {
        formatted: string
        seconds: number
    }
    terminal: {
        activeSessionCount: number
        workspaceCount: number
    }
}

// ============================================
// Split Terminal View Types
// ============================================

// Layout for split terminal view (max 4 terminals)
export interface SplitTerminalLayout {
    sessionIds: string[]    // Session IDs to display in split view (max 4)
    sizes?: number[]        // Optional custom sizes as percentages (e.g., [50, 50])
}

// Layout for fullscreen terminal window (max 6 terminals)
export interface FullscreenTerminalLayout {
    sessionIds: string[]    // Session IDs to display (max 6)
}

// ============================================
// Keyboard Shortcut Types
// ============================================

export type ShortcutAction =
    | 'nextSession' | 'prevSession'
    | 'nextWorkspace' | 'prevWorkspace'
    | 'nextSplitPane' | 'prevSplitPane'
    | 'toggleSidebar' | 'toggleSettings'
    | 'fileSearch' | 'contentSearch'
    | 'newSession' | 'closeSession' | 'clearSession' | 'renameSession'

export interface KeyBinding {
    key: string                          // Display key label (e.g., ']', '[', '`')
    modifiers: ('mod' | 'shift' | 'alt')[]  // 'mod' = Cmd on Mac, Ctrl elsewhere
    code: string                         // KeyboardEvent.key value to match
}

export type KeyboardShortcutMap = Record<ShortcutAction, KeyBinding>

export const DEFAULT_SHORTCUTS: KeyboardShortcutMap = {
    nextSession:     { key: ']', modifiers: ['mod'], code: ']' },
    prevSession:     { key: '[', modifiers: ['mod'], code: '[' },
    nextWorkspace:   { key: ']', modifiers: ['mod', 'shift'], code: ']' },
    prevWorkspace:   { key: '[', modifiers: ['mod', 'shift'], code: '[' },
    nextSplitPane:   { key: '`', modifiers: ['mod'], code: '`' },
    prevSplitPane:   { key: '`', modifiers: ['mod', 'shift'], code: '`' },
    toggleSidebar:   { key: 'B', modifiers: ['mod'], code: 'b' },
    toggleSettings:  { key: ',', modifiers: ['mod'], code: ',' },
    fileSearch:      { key: 'P', modifiers: ['mod'], code: 'p' },
    contentSearch:   { key: 'F', modifiers: ['mod', 'shift'], code: 'f' },
    newSession:      { key: 'T', modifiers: ['mod'], code: 't' },
    closeSession:    { key: 'W', modifiers: ['mod'], code: 'w' },
    clearSession:    { key: 'K', modifiers: ['mod'], code: 'k' },
    renameSession:   { key: 'R', modifiers: ['mod'], code: 'r' },
}

export type ShortcutGroup = 'navigation' | 'splitView' | 'search' | 'ui' | 'actions'

export interface ShortcutInfo {
    label: string
    description: string
    group: ShortcutGroup
}

export const SHORTCUT_LABELS: Record<ShortcutAction, ShortcutInfo> = {
    nextSession:     { label: 'Next Tab',            description: 'Switch to the next tab in workspace',      group: 'navigation' },
    prevSession:     { label: 'Previous Tab',        description: 'Switch to the previous tab in workspace',  group: 'navigation' },
    nextWorkspace:   { label: 'Next Workspace',      description: 'Switch to the next workspace',             group: 'navigation' },
    prevWorkspace:   { label: 'Previous Workspace',  description: 'Switch to the previous workspace',         group: 'navigation' },
    nextSplitPane:   { label: 'Next Split Pane',     description: 'Focus next pane in split view',            group: 'splitView' },
    prevSplitPane:   { label: 'Previous Split Pane', description: 'Focus previous pane in split view',        group: 'splitView' },
    toggleSidebar:   { label: 'Toggle Sidebar',      description: 'Show or hide the sidebar',                 group: 'ui' },
    toggleSettings:  { label: 'Toggle Settings',     description: 'Open or close settings',                   group: 'ui' },
    fileSearch:      { label: 'File Search',         description: 'Search files by name',                     group: 'search' },
    contentSearch:   { label: 'Content Search',      description: 'Search inside file contents',              group: 'search' },
    newSession:      { label: 'New Tab',             description: 'Create a new terminal tab',                group: 'actions' },
    closeSession:    { label: 'Close Tab',           description: 'Close current tab and go to previous',     group: 'actions' },
    clearSession:    { label: 'Clear Terminal',      description: 'Clear terminal scrollback buffer',         group: 'actions' },
    renameSession:   { label: 'Rename Tab',          description: 'Rename the current tab',                   group: 'actions' },
}

export const SHORTCUT_GROUP_NAMES: Record<ShortcutGroup, string> = {
    navigation: 'Navigation',
    splitView: 'Split View',
    search: 'Search',
    ui: 'UI',
    actions: 'Actions',
}
