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
    memo?: string  // Quick notepad text per session
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
    folderId?: string  // Folder this workspace belongs to
    parentWorkspaceId?: string  // Worktree인 경우 부모 workspace ID
    branchName?: string  // Worktree의 브랜치명
    baseBranch?: string  // Worktree 생성 시 분기한 브랜치 (merge 대상)
}

export interface WorkspaceFolder {
    id: string
    name: string
    isExpanded?: boolean  // Collapse/expand state in sidebar
    createdAt: number
}

export interface AppConfig {
    workspaces: Workspace[]
    folders?: WorkspaceFolder[]
    playgroundPath: string
    settings?: UserSettings
    customTemplates?: TerminalTemplate[]
    loopProjects?: LoopProject[]   // Loop Dashboard: projects promoted from workspaces
    loopSessions?: LoopSession[]   // Loop Dashboard: persisted loop sessions
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
    /**
     * Poll for listening ports. Off means no `lsof` subprocesses at all — the
     * single most expensive recurring task in the app. Manual refresh still
     * works from the status bar.
     */
    portMonitorEnabled?: boolean
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
    // Official CLI hook integration (Claude Code hooks / statusLine, Codex notify)
    agentHooks?: HookIntegrationSettings
    // Usage threshold alerts for Claude Code / Codex rate limits
    usageAlerts?: UsageAlertSettings
    // Feedback email for issue reporting
    feedbackEmail?: string
    // Loop Dashboard: loop-count detection tuning
    loopDetection?: LoopDetectionConfig
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
    | 'toggleMemo'

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
    toggleMemo:      { key: 'J', modifiers: ['mod'], code: 'j' },
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
    toggleMemo:      { label: 'Toggle Memo',         description: 'Open or close session memo',               group: 'actions' },
}

export const SHORTCUT_GROUP_NAMES: Record<ShortcutGroup, string> = {
    navigation: 'Navigation',
    splitView: 'Split View',
    search: 'Search',
    ui: 'UI',
    actions: 'Actions',
}

// ============================================
// Loop Dashboard Types
// ============================================

// Loop execution status for a Claude Code /loop session.
// running: claude is actively generating output
// ready:   output settled, waiting between iterations
// stopped: the loop/terminal is no longer alive (manual restart needed)
export type LoopStatus = 'running' | 'ready' | 'stopped'

// How a loop iteration is counted from terminal status transitions.
// settle: count when running -> ready (an iteration completed) [default]
// start:  count when ready -> running (an iteration started)
export type LoopCountMode = 'settle' | 'start'

// A project promoted from a main-window workspace into the Loop Dashboard.
export interface LoopProject {
    id: string
    name: string
    path: string                  // working directory (cwd)
    sourceWorkspaceId: string     // workspace this was promoted from
    createdAt: number
}

// A terminal session running Claude Code /loop inside a LoopProject.
export interface LoopSession {
    id: string
    loopProjectId: string
    terminalId: string            // node-pty terminal id
    cliToolName: string           // e.g. 'claude'
    cliSessionId?: string         // claude --session-id (enables --resume on restart)
    status: LoopStatus
    loopCount: number             // number of detected loop iterations
    lastLoopAt: number | null     // timestamp of the most recent iteration
    startedAt: number
    statusSince?: number          // timestamp the current status began (for status-duration stats)
    recentLoops?: Array<{ index: number; at: number }>  // recent iteration timeline (capped), newest last
}

// A single detected loop iteration ("when it looped").
export interface LoopIterationEvent {
    loopSessionId: string
    index: number                 // 1-based iteration number
    at: number                    // timestamp
}

// Tuning for loop-count detection.
export interface LoopDetectionConfig {
    countMode: LoopCountMode      // default 'settle'
    debounceMs: number            // absorb sub-debounce ready flicker (default 3000)
    customPattern?: string        // optional regex; if set, count matching output lines
    stoppedIdleMs?: number        // total silence (ms) before marking 'stopped' (default 120000)
}

export const DEFAULT_LOOP_DETECTION: LoopDetectionConfig = {
    countMode: 'settle',
    debounceMs: 3000,
    stoppedIdleMs: 120000,
}

// ============================================
// Loop Dashboard IPC Contract
// (imported by both main and preload to keep channel names in sync)
// ============================================

export const LOOP_CHANNELS = {
    promote: 'loop-promote',           // invoke: promote a workspace to a LoopProject
    list: 'loop-list',                 // invoke: get current LoopState snapshot
    openWindow: 'loop-open-window',    // invoke: open (or focus) the Loop Dashboard window
    openTerminal: 'loop-open-terminal',// invoke: create a new loop terminal session
    restart: 'loop-restart',           // invoke: restart a stopped loop session
    remove: 'loop-remove',             // invoke: remove a LoopProject from the dashboard
    getConfig: 'loop-get-config',      // invoke: read LoopDetectionConfig
    setConfig: 'loop-set-config',      // invoke: write LoopDetectionConfig
    update: 'loop-update'              // send/on: main -> renderer state broadcast
} as const

// Snapshot of all loop state delivered to the Loop window.
export interface LoopState {
    projects: LoopProject[]
    sessions: LoopSession[]
}

// loop-update broadcast payload.
export interface LoopUpdatePayload {
    state: LoopState
}

export interface PromoteToLoopRequest {
    workspaceId: string
}

export interface OpenLoopTerminalRequest {
    loopProjectId: string
}

export interface RestartLoopRequest {
    loopSessionId: string
}

export interface RemoveLoopProjectRequest {
    loopProjectId: string
}

// ============================================
// Agent Hook Integration Types
// ============================================
//
// Official-first status detection (the approach Orca uses):
//   1. Official CLI lifecycle hooks  -> exact, event driven  (source: 'hook')
//   2. Terminal OSC title sequences  -> good, no setup       (source: 'osc')
//   3. Screen-hash heuristic         -> legacy fallback      (source: 'heuristic')
//
// Hooks write their payload to a spool directory as plain files instead of
// calling the app over HTTP. A spool write always succeeds in a few
// milliseconds even when CLI Manager is closed, so the CLI is never blocked
// or slowed down by our integration.

export type AgentToolName = 'claude' | 'codex'

// Where a status value came from. Used to decide precedence: a hook event
// always wins over the heuristic, because the heuristic guesses.
export type AgentStatusSource = 'hook' | 'osc' | 'heuristic'

// Normalized lifecycle event, translated from each CLI's own vocabulary.
export type AgentEventKind =
    | 'session-start'
    | 'turn-start'    // Claude UserPromptSubmit
    | 'turn-end'      // Claude Stop / Codex agent-turn-complete
    | 'permission'    // Claude PermissionRequest — the agent is blocked on you
    | 'notification'  // Claude Notification (idle nudge, approval prompt)
    | 'session-end'

export interface AgentEvent {
    tool: AgentToolName
    kind: AgentEventKind
    /** Claude `session_id` / Codex `thread-id`. Primary key for terminal matching. */
    cliSessionId?: string
    /** Working directory reported by the hook. Fallback key when no session id. */
    cwd?: string
    at: number
    /** Extra context, e.g. the tool name a permission request is waiting on. */
    detail?: string
}

// Status resolved for one terminal, broadcast to the renderer.
export interface AgentStatusUpdate {
    terminalId: string
    status: SessionStatus
    source: AgentStatusSource
    detail?: string
    /**
     * The agent is blocked on a human — a permission prompt or an idle nudge.
     * Distinct from `ready` (finished and quiet) so the sidebar can call it out,
     * which is the single most useful signal when several agents run at once.
     */
    awaitingInput?: boolean
    at: number
}

// ============================================
// Usage / Rate Limit Types
// ============================================

// One rate-limit window as reported by the provider itself (not estimated).
export interface UsageWindow {
    usedPercent: number
    /** Unix epoch seconds when the window resets. null when unknown. */
    resetsAt: number | null
    windowMinutes: number
    /** Short human label, e.g. '5h' or '7d'. */
    label: string
}

export interface ClaudeUsage {
    fiveHour?: UsageWindow
    sevenDay?: UsageWindow
    /** Context window consumption of the most recent session, 0-100. */
    contextPercent?: number
    updatedAt: number
}

export interface CodexUsage {
    /** Codex is tracked on its weekly window. */
    weekly?: UsageWindow
    planType?: string
    updatedAt: number
}

export interface UsageSnapshot {
    claude?: ClaudeUsage
    codex?: CodexUsage
}

// Threshold alerts. 0 disables an individual tool without disabling the rest.
export interface UsageAlertSettings {
    enabled: boolean
    claudeThresholdPercent: number
    codexThresholdPercent: number
}

export const DEFAULT_USAGE_ALERTS: UsageAlertSettings = {
    enabled: true,
    claudeThresholdPercent: 80,
    codexThresholdPercent: 80,
}

// Which official integrations to install. Each is independent so a failure or
// an opt-out in one place never disables the others.
export interface HookIntegrationSettings {
    enabled: boolean          // master switch
    claudeHooks: boolean      // ~/.claude/settings.json  -> lifecycle events
    claudeStatusLine: boolean // ~/.claude/settings.json  -> official rate_limits
    codexNotify: boolean      // ~/.codex/config.toml     -> agent-turn-complete
}

export const DEFAULT_HOOK_INTEGRATION: HookIntegrationSettings = {
    enabled: false,
    claudeHooks: true,
    claudeStatusLine: true,
    codexNotify: true,
}

// Result of the last install attempt, surfaced in Settings so a silent
// failure can never masquerade as a working integration.
export interface HookTargetState {
    installed: boolean
    /** Command we are chaining to, when we wrapped a pre-existing entry. */
    wrapped?: string
    /**
     * Nothing was installed and nothing is wrong — the target does not apply to
     * this machine. Kept distinct from `error` so a user who simply does not
     * have Codex is not shown a warning about it.
     */
    skipped?: boolean
    /** Why the target was skipped, shown as neutral text rather than a fault. */
    skipReason?: string
    error?: string
}

export interface HookInstallState {
    claudeHooks: HookTargetState
    claudeStatusLine: HookTargetState
    codexNotify: HookTargetState
}

// ============================================
// Diff Review Types
// ============================================

// What the working tree is compared against.
//   'base-branch' — worktree branch vs the branch it forked from (agent review)
//   'head'        — uncommitted changes vs HEAD (classic git diff)
export type DiffBase = 'base-branch' | 'head'

export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed'

export interface DiffFileSummary {
    path: string
    oldPath?: string
    status: DiffFileStatus
    additions: number
    deletions: number
    binary: boolean
}

export type DiffLineType = 'context' | 'add' | 'del'

export interface DiffLine {
    type: DiffLineType
    oldNumber: number | null
    newNumber: number | null
    content: string
}

export interface DiffHunk {
    header: string
    lines: DiffLine[]
}

export interface FileDiff {
    path: string
    oldPath?: string
    status: DiffFileStatus
    hunks: DiffHunk[]
    binary: boolean
    /** Set when the diff was truncated because the file changed too much. */
    truncated: boolean
}

export interface DiffSummary {
    base: DiffBase
    /** Human label of the comparison, e.g. 'main...feat/login'. */
    baseLabel: string
    files: DiffFileSummary[]
    totalAdditions: number
    totalDeletions: number
}
