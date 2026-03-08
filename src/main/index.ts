import { app, shell, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu } from 'electron'
import path, { join } from 'path'
import { electronApp, is } from '@electron-toolkit/utils'
import { autoUpdater } from 'electron-updater'
import icon from '../../resources/icon.png?asset'
import logoIcon from '../../resources/logo-final.png?asset'
import Store from 'electron-store'
import { AppConfig, Workspace, TerminalSession, UserSettings, IPCResult, LicenseData, LicenseInfo, WorkspaceFolder } from '../shared/types'
import { v4 as uuidv4 } from 'uuid'
import simpleGit from 'simple-git'
import { existsSync, mkdirSync, readdirSync, statSync, readFileSync } from 'fs'
import { exec } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import { rgPath } from '@vscode/ripgrep'

import { TerminalManager } from './TerminalManager'
import { PortManager } from './PortManager'
import { SystemMonitor } from './SystemMonitor'
import { LicenseManager } from './LicenseManager'
import { CLISessionTracker } from './CLISessionTracker'
import { net } from 'electron'

// Set app name for development mode
app.setName('CLI Manager')

// Auto Updater 설정
// User must click "Download" button to start download (not automatic)
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = true

const execAsync = promisify(exec)

// Get ripgrep path for development and production modes
const getRipgrepPath = (): string => {
    if (is.dev) {
        // In development mode, use node_modules path
        const devPath = path.join(__dirname, '../../node_modules/@vscode/ripgrep/bin/rg')
        console.log('[getRipgrepPath] Development mode, using:', devPath)
        return devPath
    }
    // In production mode, use bundled path
    console.log('[getRipgrepPath] Production mode, using:', rgPath)
    return rgPath
}

// Fix PATH for packaged app on macOS
// When launched from Finder/Spotlight, the app doesn't inherit shell PATH
// This ensures git, gh, and other CLI tools are found
const fixPath = async (): Promise<void> => {
    if (process.platform !== 'darwin') return
    if (process.env.PATH?.includes('/usr/local/bin')) return // Already fixed

    try {
        const shell = process.env.SHELL || '/bin/zsh'
        const { stdout } = await execAsync(`${shell} -l -c 'echo $PATH'`)
        const shellPath = stdout.trim()
        if (shellPath) {
            process.env.PATH = shellPath
            console.log('[fixPath] PATH updated from shell:', shellPath.substring(0, 100) + '...')
        }
    } catch (e) {
        console.error('[fixPath] Failed to get shell PATH:', e)
    }
}

// Helper function to execute commands with login shell
// This ensures PATH is properly loaded when app is launched from Finder/Spotlight
// Without this, commands like 'code', 'gh', 'git' may not be found in release builds
const execWithShell = async (command: string, options?: { cwd?: string }): Promise<{ stdout: string; stderr: string }> => {
    const shell = process.env.SHELL || '/bin/zsh'
    const escapedCommand = command.replace(/'/g, "'\\''")

    if (options?.cwd) {
        const escapedCwd = options.cwd.replace(/'/g, "'\\''")
        return execAsync(`${shell} -l -c 'cd "${escapedCwd}" && ${escapedCommand}'`)
    }
    return execAsync(`${shell} -l -c '${escapedCommand}'`)
}

const store = new Store<AppConfig>({
    defaults: {
        workspaces: [],
        playgroundPath: app.getPath('downloads'),
        customTemplates: [],
        settings: {
            theme: 'dark',
            fontSize: 14,
            fontFamily: 'Monaco, Courier New, monospace',
            defaultShell: 'zsh',
            defaultEditor: 'vscode',
            customEditorPath: undefined,
            portFilter: {
                enabled: true,
                minPort: 3000,
                maxPort: 9000
            },
            ignoredPorts: [],
            ignoredProcesses: [],
            portActionLogs: [],
            hooks: {
                enabled: true,
                claudeCode: {
                    enabled: true,
                    detectRunning: true,
                    detectReady: true,
                    detectError: false,
                    showInSidebar: true,
                    autoDismissSeconds: 5
                }
            }
        }
    }
}) as any

// Separate store for license data (to keep it secure)
const licenseStore = new Store({
    name: 'license',
    defaults: {
        license: null as LicenseData | null
    }
}) as any

const cliSessionTracker = new CLISessionTracker()
const terminalManager = new TerminalManager(cliSessionTracker)
const portManager = new PortManager()
const systemMonitor = new SystemMonitor(store)
const licenseManager = new LicenseManager(licenseStore)

// Background mode state
let tray: Tray | null = null
let isQuitting = false  // True when user confirms to quit completely
let isBackgroundMode = false  // True when running in background (window hidden)

// Main window reference for IPC communication
let mainWindow: BrowserWindow | null = null

// Validate if a path exists and is accessible
function isValidPath(dirPath: string): boolean {
    try {
        return existsSync(dirPath)
    } catch {
        return false
    }
}

// Create or get home workspace (with defensive programming)
// Returns null if home workspace is disabled or path is invalid
function ensureHomeWorkspace(): Workspace | null {
    try {
        const settings = store.get('settings') as UserSettings | undefined
        const workspaces = store.get('workspaces') as Workspace[]
        const existingHome = workspaces.find((w: Workspace) => w.isHome)

        // Check if home workspace is disabled in settings (default: true)
        const showHomeWorkspace = settings?.showHomeWorkspace ?? true
        console.log('[Home Workspace] showHomeWorkspace setting:', showHomeWorkspace, 'existingHome:', !!existingHome)

        if (!showHomeWorkspace) {
            // Remove existing home workspace if disabled
            if (existingHome) {
                const filtered = workspaces.filter(w => !w.isHome)
                store.set('workspaces', filtered)
                console.log('[Home Workspace] Removed (disabled in settings)')
            }
            return null
        }

        // Determine home path (custom or system default)
        const customPath = settings?.homeWorkspacePath
        let homePath: string

        if (customPath && customPath.trim()) {
            // Use custom path if valid
            if (isValidPath(customPath)) {
                homePath = customPath
            } else {
                console.warn('[Home Workspace] Custom path invalid, falling back to system home:', customPath)
                homePath = os.homedir()
            }
        } else {
            homePath = os.homedir()
        }

        // Validate home path exists
        if (!isValidPath(homePath)) {
            console.error('[Home Workspace] Home path does not exist:', homePath)
            return null
        }

        // Update existing home workspace path if changed
        if (existingHome) {
            if (existingHome.path !== homePath) {
                // Path changed, update it
                existingHome.path = homePath
                // Update session cwd as well
                existingHome.sessions = existingHome.sessions.map(s => ({
                    ...s,
                    cwd: homePath
                }))
                store.set('workspaces', workspaces)
                console.log('[Home Workspace] Path updated:', homePath)
            }
            return existingHome
        }

        // Create home workspace with terminal-style name
        let username = 'user'
        let hostname = 'local'

        try {
            username = os.userInfo().username || 'user'
        } catch {
            console.warn('[Home Workspace] Could not get username')
        }

        try {
            hostname = os.hostname() || 'local'
        } catch {
            console.warn('[Home Workspace] Could not get hostname')
        }

        // Format: username@hostname (like terminal prompt)
        const homeName = `${username}@${hostname}`

        const homeWorkspace: Workspace = {
            id: uuidv4(),
            name: homeName,
            path: homePath,
            sessions: [
                {
                    id: uuidv4(),
                    name: 'Main',
                    cwd: homePath,
                    type: 'regular'
                }
            ],
            createdAt: Date.now(),
            isHome: true
        }

        // Add home workspace at the beginning
        store.set('workspaces', [homeWorkspace, ...workspaces])
        console.log('[Home Workspace] Created:', homeName, 'at', homePath)

        return homeWorkspace
    } catch (error) {
        console.error('[Home Workspace] Unexpected error:', error)
        return null
    }
}

interface ParsedWorktree {
    path: string
    branchName: string
}

interface WorktreeSyncSummary {
    imported: number
    removed: number
    updated: number
}

function parseWorktreeListPorcelain(output: string): ParsedWorktree[] {
    const parsed: ParsedWorktree[] = []
    const entries = output.split('\n\n')

    for (const entry of entries) {
        const lines = entry.split('\n').map(line => line.trim()).filter(Boolean)
        if (lines.length === 0) continue

        let worktreePath: string | undefined
        let branchName: string | undefined

        for (const line of lines) {
            if (line.startsWith('worktree ')) {
                worktreePath = line.slice('worktree '.length).trim()
                continue
            }
            if (line.startsWith('branch refs/heads/')) {
                branchName = line.slice('branch refs/heads/'.length).trim()
            }
        }

        // Only import branch-backed worktrees to keep existing merge/delete assumptions.
        if (worktreePath && branchName) {
            parsed.push({
                path: path.resolve(worktreePath),
                branchName
            })
        }
    }

    return parsed
}

async function syncWorktreeWorkspaces(): Promise<WorktreeSyncSummary> {
    const summary: WorktreeSyncSummary = { imported: 0, removed: 0, updated: 0 }

    const workspaces = (store.get('workspaces') as Workspace[]) || []
    const parentWorkspaces = workspaces.filter(w => !w.parentWorkspaceId && !w.isPlayground && !w.isHome)

    // parentWorkspaceId -> (resolvedPath -> branchName)
    const discoveredByParent = new Map<string, Map<string, string>>()

    for (const parent of parentWorkspaces) {
        try {
            const git = simpleGit(parent.path)
            const isRepo = await git.checkIsRepo()
            if (!isRepo) continue

            const worktreeOutput = await git.raw(['worktree', 'list', '--porcelain'])
            const parsed = parseWorktreeListPorcelain(worktreeOutput)
            const parentResolvedPath = path.resolve(parent.path)

            const discovered = new Map<string, string>()
            for (const item of parsed) {
                if (item.path === parentResolvedPath) continue
                discovered.set(item.path, item.branchName)
            }

            discoveredByParent.set(parent.id, discovered)
        } catch (error) {
            // Skip this workspace on scan failure to avoid accidental stale deletion.
            console.error('[sync-worktree-workspaces] Failed to scan parent workspace:', parent.path, error)
        }
    }

    let changed = false
    const nextWorkspaces: Workspace[] = []

    for (const workspace of workspaces) {
        if (!workspace.parentWorkspaceId) {
            nextWorkspaces.push(workspace)
            continue
        }

        const discovered = discoveredByParent.get(workspace.parentWorkspaceId)
        if (!discovered) {
            nextWorkspaces.push(workspace)
            continue
        }

        const workspaceResolvedPath = path.resolve(workspace.path)
        const discoveredBranchName = discovered.get(workspaceResolvedPath)
        if (!discoveredBranchName) {
            summary.removed += 1
            changed = true
            continue
        }

        discovered.delete(workspaceResolvedPath)

        if (workspace.branchName !== discoveredBranchName) {
            summary.updated += 1
            changed = true
            nextWorkspaces.push({
                ...workspace,
                branchName: discoveredBranchName
            })
            continue
        }

        nextWorkspaces.push(workspace)
    }

    for (const parent of parentWorkspaces) {
        const discovered = discoveredByParent.get(parent.id)
        if (!discovered || discovered.size === 0) continue

        for (const [worktreePath, branchName] of discovered.entries()) {
            const alreadyTracked = nextWorkspaces.some(workspace => path.resolve(workspace.path) === worktreePath)
            if (alreadyTracked) continue

            const importedWorkspace: Workspace = {
                id: uuidv4(),
                name: branchName,
                path: worktreePath,
                sessions: [
                    {
                        id: uuidv4(),
                        name: 'Main',
                        cwd: worktreePath,
                        type: 'regular'
                    }
                ],
                createdAt: Date.now(),
                parentWorkspaceId: parent.id,
                branchName
            }

            nextWorkspaces.push(importedWorkspace)
            summary.imported += 1
            changed = true
        }
    }

    if (changed) {
        store.set('workspaces', nextWorkspaces)
    }

    return summary
}

function createWindow(): void {
    // Create the browser window.
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        autoHideMenuBar: true,
        titleBarStyle: 'hiddenInset', // Mac-style title bar
        vibrancy: 'under-window', // Glass effect
        visualEffectState: 'active',
        trafficLightPosition: { x: 15, y: 10 },
        icon,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false,
            zoomFactor: 1  // 줌 팩터를 1로 고정
        }
    })

    mainWindow.on('ready-to-show', () => {
        mainWindow?.show()
    })

    // Cmd+/- 기본 줌 완전 비활성화 (터미널 폰트만 조정)
    // 줌 레벨을 1로 고정하여 전체 UI 줌 방지
    mainWindow.webContents.setZoomFactor(1)
    mainWindow.webContents.setZoomLevel(0)
    mainWindow.webContents.setVisualZoomLevelLimits(1, 1)

    // before-input-event로 Cmd+/-/0 키를 가로채서 터미널 폰트 조정
    mainWindow.webContents.on('before-input-event', (event, input) => {
        // macOS: meta (Cmd), Windows/Linux: control
        const isModifier = input.meta || input.control

        if (isModifier && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
            // 기본 줌 동작 방지
            event.preventDefault()
            // 렌더러로 IPC 전송 (터미널 폰트 크기 조정)
            mainWindow?.webContents.send('terminal-zoom', input.key)
        }
    })

    mainWindow.webContents.setWindowOpenHandler((details) => {
        shell.openExternal(details.url)
        return { action: 'deny' }
    })

    // HMR for renderer base on electron-vite cli.
    // Load the remote URL for development or the local html file for production.
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
        mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
}

// Grid window reference for sync
let gridWindow: BrowserWindow | null = null

// Create fullscreen terminal window for split view
function createFullscreenTerminalWindow(sessionIds: string[]): void {
    // Close existing grid window if any
    if (gridWindow && !gridWindow.isDestroyed()) {
        gridWindow.close()
    }

    const fullscreenWindow = new BrowserWindow({
        width: 1600,
        height: 900,
        show: false,
        autoHideMenuBar: true,
        titleBarStyle: 'hiddenInset',
        vibrancy: 'under-window',
        visualEffectState: 'active',
        trafficLightPosition: { x: 15, y: 10 },
        icon,
        webPreferences: {
            preload: join(__dirname, '../preload/index.js'),
            sandbox: false,
            contextIsolation: true,
            nodeIntegration: false,
            zoomFactor: 1
        }
    })

    // Store reference for sync
    gridWindow = fullscreenWindow

    fullscreenWindow.on('ready-to-show', () => {
        fullscreenWindow.show()
        // Notify main window that grid view is open
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('grid-view-state-changed', true, sessionIds)
        }
    })

    // Clear reference when closed
    fullscreenWindow.on('closed', () => {
        gridWindow = null
        // Notify main window that grid view is closed
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('grid-view-state-changed', false, [])
        }
    })

    // Disable zoom for fullscreen window
    fullscreenWindow.webContents.setZoomFactor(1)
    fullscreenWindow.webContents.setZoomLevel(0)
    fullscreenWindow.webContents.setVisualZoomLevelLimits(1, 1)

    // Handle terminal zoom for this window
    fullscreenWindow.webContents.on('before-input-event', (event, input) => {
        const isModifier = input.meta || input.control
        if (isModifier && (input.key === '=' || input.key === '+' || input.key === '-' || input.key === '0')) {
            event.preventDefault()
            fullscreenWindow.webContents.send('terminal-zoom', input.key)
        }
    })

    // Load with fullscreen mode query parameters
    const sessionIdsParam = sessionIds.join(',')
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
        fullscreenWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?mode=fullscreen&sessions=${sessionIdsParam}`)
    } else {
        fullscreenWindow.loadFile(join(__dirname, '../renderer/index.html'), {
            query: { mode: 'fullscreen', sessions: sessionIdsParam }
        })
    }
}

// Validate cliSessionIds on startup against Claude's actual session storage.
// If the JSONL file doesn't exist, the session was never saved — clear the stale ID.
function validateCliSessionIds(): void {
    console.log('[validateCliSessionIds] Starting validation...')
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
    const projectsDir = path.join(claudeDir, 'projects')

    if (!existsSync(projectsDir)) {
        console.log('[validateCliSessionIds] Claude projects dir not found:', projectsDir)
        return
    }

    // Collect all existing session IDs from Claude's storage
    const existingSessionIds = new Set<string>()
    try {
        const projectDirs = readdirSync(projectsDir)
        for (const dir of projectDirs) {
            const dirPath = path.join(projectsDir, dir)
            try {
                const files = readdirSync(dirPath)
                for (const file of files) {
                    if (file.endsWith('.jsonl')) {
                        existingSessionIds.add(file.replace('.jsonl', ''))
                    }
                }
            } catch { /* skip unreadable dirs */ }
        }
    } catch (e) {
        console.error('[validateCliSessionIds] Failed to scan projects dir:', e)
        return
    }

    console.log(`[validateCliSessionIds] Found ${existingSessionIds.size} session(s) in Claude storage`)

    const workspaces = store.get('workspaces') as Workspace[]
    let modified = false
    for (const ws of workspaces) {
        for (const session of ws.sessions) {
            if (session.cliSessionId) {
                if (existingSessionIds.has(session.cliSessionId)) {
                    console.log(`[validateCliSessionIds] KEEP session ${session.cliSessionId} (file exists)`)
                } else {
                    console.log(`[validateCliSessionIds] CLEAR stale session ${session.cliSessionId} (no file)`)
                    delete session.cliSessionId
                    delete session.cliToolName
                    modified = true
                }
            }
        }
    }
    if (modified) {
        store.set('workspaces', workspaces)
    }
}

// Clear all cliSessionIds on graceful quit (belt-and-suspenders with validateCliSessionIds).
function clearAllCliSessionIds(): void {
    const workspaces = store.get('workspaces') as Workspace[]
    let modified = false
    let count = 0
    for (const ws of workspaces) {
        for (const session of ws.sessions) {
            if (session.cliSessionId || session.cliToolName) {
                delete session.cliSessionId
                delete session.cliToolName
                modified = true
                count++
            }
        }
    }
    if (modified) {
        console.log(`[clearAllCliSessionIds] Cleared ${count} CLI session(s)`)
        store.set('workspaces', workspaces)
    }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(async () => {
    // Fix PATH for packaged app (must be first!)
    await fixPath()

    // Validate persisted cliSessionIds against Claude's session storage
    validateCliSessionIds()

    // Set app user model id for windows
    electronApp.setAppUserModelId('com.climanager.app')

    // Custom application menu without Reload (Cmd+R) to avoid conflict with session rename shortcut
    const appMenu = Menu.buildFromTemplate([
        {
            label: app.name,
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' }
            ]
        },
        {
            label: 'Window',
            submenu: [
                { role: 'minimize' },
                { role: 'close' },
                { role: 'togglefullscreen' }
            ]
        }
    ])
    Menu.setApplicationMenu(appMenu)

    // Set dock icon for macOS (built app uses icon.icns automatically)
    if (process.platform === 'darwin' && app.dock) {
        try {
            app.dock.setIcon(icon)
        } catch (e) {
            // Icon loading may fail in packaged app, but icon.icns is used automatically
            console.log('Dock icon set via icon.icns')
        }
    }

    // 자동 업데이트 체크 (프로덕션 환경에서만)
    if (!is.dev) {
        autoUpdater.checkForUpdatesAndNotify()
    }

    // Custom shortcut handling instead of optimizer.watchWindowShortcuts
    // We do NOT block Cmd+R in production because it's used for session rename
    app.on('browser-window-created', (_, window) => {
        window.webContents.on('before-input-event', (event, input) => {
            // Allow F12 to toggle DevTools in development only
            if (input.key === 'F12') {
                if (is.dev) {
                    window.webContents.toggleDevTools()
                }
                event.preventDefault()
            }
        })
    })

    // IPC Handlers

    // Open fullscreen terminal window
    ipcMain.handle('open-fullscreen-terminal', (_event, sessionIds: string[]) => {
        if (sessionIds && sessionIds.length > 0) {
            createFullscreenTerminalWindow(sessionIds)
            return true
        }
        return false
    })

    // Sync grid window sessions (main ↔ grid, both windows stay in sync)
    ipcMain.handle('sync-grid-sessions', (_event, sessionIds: string[]) => {
        if (gridWindow && !gridWindow.isDestroyed()) {
            gridWindow.webContents.send('grid-sessions-updated', sessionIds)
            // Also update main window's gridViewSessionIds to stay in sync
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('grid-view-state-changed', true, sessionIds)
            }
            return true
        }
        return false
    })

    // CLI Session Tracker: when a CLI tool is detected from manual typing
    cliSessionTracker.onSessionDetected = (info) => {
        // Find which workspace/session this terminal belongs to and persist
        const workspaces = store.get('workspaces') as Workspace[]
        for (const ws of workspaces) {
            const session = ws.sessions.find((s: TerminalSession) => s.id === info.terminalId)
            if (session) {
                session.cliSessionId = info.cliSessionId
                session.cliToolName = info.cliToolName
                store.set('workspaces', workspaces)

                // Notify renderer
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('cli-session-detected', {
                        workspaceId: ws.id,
                        sessionId: info.terminalId,
                        cliSessionId: info.cliSessionId,
                        cliToolName: info.cliToolName
                    })
                }
                break
            }
        }
    }

    // Update CLI session info on a session (from renderer, e.g., template rewrite)
    ipcMain.handle('update-session-cli-info', (_, workspaceId: string, sessionId: string, cliSessionId: string, cliToolName: string): boolean => {
        console.log(`[update-session-cli-info] Persisting cliSessionId=${cliSessionId} for session=${sessionId}`)
        const workspaces = store.get('workspaces') as Workspace[]
        const ws = workspaces.find((w: Workspace) => w.id === workspaceId)
        if (!ws) return false
        const session = ws.sessions.find((s: TerminalSession) => s.id === sessionId)
        if (!session) return false
        session.cliSessionId = cliSessionId
        session.cliToolName = cliToolName
        store.set('workspaces', workspaces)
        return true
    })

    // Clear CLI session info (when CLI tool exits)
    ipcMain.handle('clear-session-cli-info', (_, workspaceId: string, sessionId: string): boolean => {
        const workspaces = store.get('workspaces') as Workspace[]
        const ws = workspaces.find((w: Workspace) => w.id === workspaceId)
        if (!ws) return false
        const session = ws.sessions.find((s: TerminalSession) => s.id === sessionId)
        if (!session) return false
        delete session.cliSessionId
        delete session.cliToolName
        store.set('workspaces', workspaces)
        return true
    })

    // Rewrite a command through CLISessionTracker (for template/initialCommand)
    ipcMain.handle('rewrite-cli-command', (_, command: string): { command: string; cliSessionId: string; cliToolName: string } | null => {
        const result = cliSessionTracker.rewriteCommand(command)
        console.log(`[rewrite-cli-command] "${command}" → ${result ? `"${result.command}" (id=${result.cliSessionId})` : 'null (not a CLI tool)'}`)
        return result
    })

    ipcMain.handle('get-workspaces', () => {
        // Ensure home workspace exists and is first
        ensureHomeWorkspace()
        const workspaces = store.get('workspaces') as Workspace[]

        // Sort: home first, then regular workspaces by createdAt
        return workspaces.sort((a, b) => {
            if (a.isHome) return -1
            if (b.isHome) return 1
            return a.createdAt - b.createdAt
        })
    })

    ipcMain.handle('sync-worktree-workspaces', async (): Promise<IPCResult<WorktreeSyncSummary>> => {
        try {
            const result = await syncWorktreeWorkspaces()
            return { success: true, data: result }
        } catch (e: any) {
            console.error('[sync-worktree-workspaces] ERROR:', e)
            return { success: false, error: e.message, errorType: 'UNKNOWN_ERROR' }
        }
    })

    ipcMain.handle('add-workspace', async (): Promise<IPCResult<Workspace> | null> => {
        // Check workspace limit (exclude Home and Playground from count)
        const workspaces = store.get('workspaces') as Workspace[]
        const userWorkspaceCount = workspaces.filter(w => !w.isHome && !w.isPlayground && !w.parentWorkspaceId).length
        const canAdd = licenseManager.canAddWorkspace(userWorkspaceCount)

        if (!canAdd.allowed) {
            return { success: false, error: canAdd.reason, errorType: 'UPGRADE_REQUIRED' }
        }

        const result = await dialog.showOpenDialog({
            properties: ['openDirectory']
        })

        if (result.canceled || result.filePaths.length === 0) {
            return null
        }

        const dirPath = result.filePaths[0]
        const name = dirPath.split('/').pop() || 'Untitled'

        const newWorkspace: Workspace = {
            id: uuidv4(),
            name,
            path: dirPath,
            sessions: [
                {
                    id: uuidv4(),
                    name: 'Main',
                    cwd: dirPath,
                    type: 'regular'
                }
            ],
            createdAt: Date.now()
        }

        store.set('workspaces', [...workspaces, newWorkspace])
        return { success: true, data: newWorkspace }
    })

    ipcMain.handle('add-session', async (_, workspaceId: string, type: 'regular' | 'worktree', branchName?: string, initialCommand?: string, sessionName?: string): Promise<IPCResult<TerminalSession> | null> => {
        const workspaces = store.get('workspaces') as Workspace[]
        const workspace = workspaces.find((w: Workspace) => w.id === workspaceId)

        if (!workspace) return null

        // Check session limit
        const canAdd = licenseManager.canAddSession(workspace.sessions.length)
        if (!canAdd.allowed) {
            return { success: false, error: canAdd.reason, errorType: 'UPGRADE_REQUIRED' }
        }

        // Worktree is now created as a separate workspace, not a session
        if (type === 'worktree') {
            console.warn('Use add-worktree-workspace instead')
            return null
        }

        const newSession: TerminalSession = {
            id: uuidv4(),
            name: sessionName || 'Terminal',
            cwd: workspace.path,
            type,
            initialCommand
        }

        workspace.sessions.push(newSession)

        // Update workspace in store
        store.set('workspaces', workspaces)

        return { success: true, data: newSession }
    })

    // Create worktree as a separate workspace
    ipcMain.handle('add-worktree-workspace', async (_, parentWorkspaceId: string, branchName: string): Promise<IPCResult<Workspace>> => {
        // Check if worktree feature is available
        const canUseWorktree = licenseManager.canUseWorktree()
        if (!canUseWorktree.allowed) {
            return { success: false, error: canUseWorktree.reason, errorType: 'UPGRADE_REQUIRED' }
        }

        const workspaces = store.get('workspaces') as Workspace[]
        const parentWorkspace = workspaces.find((w: Workspace) => w.id === parentWorkspaceId)

        if (!parentWorkspace) {
            return { success: false, error: 'Parent workspace not found', errorType: 'UNKNOWN_ERROR' }
        }

        const git = simpleGit(parentWorkspace.path)
        const settings = store.get('settings') as UserSettings

        // Replace slashes in branch name with hyphens
        const sanitizedBranchName = branchName.replace(/\//g, '-')

        // Determine worktree path: use custom path if set, otherwise default
        let worktreePath: string
        if (settings?.worktreePath) {
            // Custom path: {worktreePath}/{workspace-name}/{branch-name}
            worktreePath = path.join(settings.worktreePath, parentWorkspace.name, sanitizedBranchName)
        } else {
            // Default path: {workspace}/../{name}-worktrees/{branch}
            worktreePath = path.join(
                path.dirname(parentWorkspace.path),
                `${parentWorkspace.name}-worktrees`,
                sanitizedBranchName
            )
        }

        // Create worktree directory parent if it doesn't exist
        const worktreesDir = path.dirname(worktreePath)
        if (!existsSync(worktreesDir)) {
            mkdirSync(worktreesDir, { recursive: true })
        }

        try {
            // Check if it's a git repository
            const isRepo = await git.checkIsRepo()
            if (!isRepo) {
                return { success: false, error: 'Not a git repository', errorType: 'NOT_A_REPO' }
            }

            // Check if branch already exists
            const branches = await git.branch()
            if (branches.all.includes(branchName)) {
                return { success: false, error: `Branch '${branchName}' already exists`, errorType: 'BRANCH_EXISTS' }
            }

            // Check if worktree path already exists
            if (existsSync(worktreePath)) {
                return { success: false, error: `Worktree path '${worktreePath}' already exists`, errorType: 'WORKTREE_EXISTS' }
            }

            // git worktree add -b <branch> <path>
            await git.raw(['worktree', 'add', '-b', branchName, worktreePath])

            // Create new worktree workspace
            // Save the current branch as baseBranch (the branch we branched from)
            const newWorktreeWorkspace: Workspace = {
                id: uuidv4(),
                name: branchName,
                path: worktreePath,
                sessions: [
                    {
                        id: uuidv4(),
                        name: 'Main',
                        cwd: worktreePath,
                        type: 'regular'
                    }
                ],
                createdAt: Date.now(),
                parentWorkspaceId: parentWorkspaceId,
                branchName: branchName,
                baseBranch: branches.current || 'main'  // The branch we branched from
            }

            store.set('workspaces', [...workspaces, newWorktreeWorkspace])
            return { success: true, data: newWorktreeWorkspace }
        } catch (e: any) {
            console.error('Failed to create worktree:', e)
            return { success: false, error: e.message, errorType: 'UNKNOWN_ERROR' }
        }
    })

    ipcMain.handle('remove-workspace', async (_, id: string, deleteBranch: boolean = true) => {
        const workspaces = store.get('workspaces') as Workspace[]
        const workspace = workspaces.find((w: Workspace) => w.id === id)

        if (!workspace) return false

        // Prevent deletion of home workspace
        if (workspace.isHome) {
            console.log('[remove-workspace] Cannot delete home workspace')
            return false
        }

        // Worktree workspace인 경우 git worktree remove 실행
        if (workspace.parentWorkspaceId && workspace.branchName) {
            const parentWorkspace = workspaces.find((w: Workspace) => w.id === workspace.parentWorkspaceId)

            if (parentWorkspace) {
                const git = simpleGit(parentWorkspace.path)

                try {
                    // 1. git worktree remove <path>
                    await git.raw(['worktree', 'remove', workspace.path, '--force'])
                    console.log(`Removed worktree: ${workspace.path}`)
                } catch (e) {
                    console.error('Failed to remove worktree:', e)
                    // Continue even if failed (may already be deleted)
                }

                // 2. Delete local branch (if deleteBranch is true)
                if (deleteBranch) {
                    try {
                        // -D flag for force delete (including unmerged branches)
                        await git.branch(['-D', workspace.branchName])
                        console.log(`Deleted local branch: ${workspace.branchName}`)
                    } catch (e) {
                        console.error('Failed to delete branch:', e)
                        // Continue with workspace deletion even if branch deletion fails
                    }
                }
            }
        }

        store.set('workspaces', workspaces.filter((w: Workspace) => w.id !== id))
        return true
    })

    ipcMain.handle('remove-session', (_, workspaceId: string, sessionId: string) => {
        const workspaces = store.get('workspaces') as Workspace[]
        const workspace = workspaces.find((w: Workspace) => w.id === workspaceId)

        if (!workspace) return false

        // Remove session from workspace
        workspace.sessions = workspace.sessions.filter(s => s.id !== sessionId)

        // Update store
        store.set('workspaces', workspaces.map(w =>
            w.id === workspaceId ? workspace : w
        ))

        return true
    })

    ipcMain.handle('rename-session', (_, workspaceId: string, sessionId: string, newName: string) => {
        const workspaces = store.get('workspaces') as Workspace[]
        const workspace = workspaces.find((w: Workspace) => w.id === workspaceId)

        if (!workspace) return false

        const session = workspace.sessions.find(s => s.id === sessionId)
        if (!session) return false

        session.name = newName

        // Update store
        store.set('workspaces', workspaces.map(w =>
            w.id === workspaceId ? workspace : w
        ))

        return true
    })

    // Save session memo
    ipcMain.handle('update-session-memo', (_, workspaceId: string, sessionId: string, memo: string) => {
        const workspaces = store.get('workspaces') as Workspace[]
        const workspace = workspaces.find((w: Workspace) => w.id === workspaceId)
        if (!workspace) return false

        const session = workspace.sessions.find(s => s.id === sessionId)
        if (!session) return false

        session.memo = memo

        store.set('workspaces', workspaces.map(w =>
            w.id === workspaceId ? workspace : w
        ))

        return true
    })

    // 세션 순서 변경 핸들러
    ipcMain.handle('reorder-sessions', (_, workspaceId: string, sessionIds: string[]) => {
        const workspaces = store.get('workspaces') as Workspace[]
        const workspace = workspaces.find((w: Workspace) => w.id === workspaceId)

        if (!workspace) return false

        // sessionIds 순서대로 세션 정렬
        const reorderedSessions = sessionIds
            .map(id => workspace.sessions.find(s => s.id === id))
            .filter((s): s is TerminalSession => s !== undefined)

        workspace.sessions = reorderedSessions

        // Update store
        store.set('workspaces', workspaces.map(w =>
            w.id === workspaceId ? workspace : w
        ))

        return true
    })

    // Workspace order change handler
    ipcMain.handle('reorder-workspaces', (_, workspaceIds: string[]) => {
        const workspaces = store.get('workspaces') as Workspace[]

        // Reorder workspaces according to workspaceIds order
        const reorderedWorkspaces = workspaceIds
            .map(id => workspaces.find(w => w.id === id))
            .filter((w): w is Workspace => w !== undefined)

        // Add any workspaces that weren't in the list (Home, Playground, Worktrees)
        const remainingWorkspaces = workspaces.filter(w => !workspaceIds.includes(w.id))
        const finalWorkspaces = [...reorderedWorkspaces, ...remainingWorkspaces]

        store.set('workspaces', finalWorkspaces)
        return true
    })

    ipcMain.handle('toggle-pin-workspace', (_, workspaceId: string) => {
        const workspaces = store.get('workspaces') as Workspace[]
        const workspace = workspaces.find(w => w.id === workspaceId)
        if (!workspace) return false

        workspace.isPinned = !workspace.isPinned
        store.set('workspaces', workspaces)

        // Notify renderer to refresh
        BrowserWindow.getAllWindows().forEach(win => {
            win.webContents.send('workspaces-updated')
        })
        return workspace.isPinned
    })

    // ============================================
    // Folder Management
    // ============================================

    ipcMain.handle('get-folders', () => {
        return (store.get('folders') || []) as WorkspaceFolder[]
    })

    ipcMain.handle('create-folder', (_, name: string) => {
        const folders = (store.get('folders') || []) as WorkspaceFolder[]
        const newFolder: WorkspaceFolder = {
            id: uuidv4(),
            name,
            isExpanded: true,
            createdAt: Date.now()
        }
        folders.push(newFolder)
        store.set('folders', folders)
        return newFolder
    })

    ipcMain.handle('rename-folder', (_, folderId: string, newName: string) => {
        const folders = (store.get('folders') || []) as WorkspaceFolder[]
        const folder = folders.find(f => f.id === folderId)
        if (!folder) return false

        folder.name = newName
        store.set('folders', folders)
        return true
    })

    ipcMain.handle('remove-folder', (_, folderId: string) => {
        const folders = (store.get('folders') || []) as WorkspaceFolder[]
        const updatedFolders = folders.filter(f => f.id !== folderId)
        store.set('folders', updatedFolders)

        // Remove folderId from all workspaces in this folder
        const workspaces = store.get('workspaces') as Workspace[]
        workspaces.forEach(w => {
            if (w.folderId === folderId) {
                w.folderId = undefined
            }
        })
        store.set('workspaces', workspaces)
        return true
    })

    ipcMain.handle('toggle-folder-expanded', (_, folderId: string) => {
        const folders = (store.get('folders') || []) as WorkspaceFolder[]
        const folder = folders.find(f => f.id === folderId)
        if (!folder) return false

        folder.isExpanded = !folder.isExpanded
        store.set('folders', folders)
        return folder.isExpanded
    })

    ipcMain.handle('move-workspace-to-folder', (_, workspaceId: string, folderId: string | null) => {
        const workspaces = store.get('workspaces') as Workspace[]
        const workspace = workspaces.find(w => w.id === workspaceId)
        if (!workspace) return false

        workspace.folderId = folderId || undefined
        store.set('workspaces', workspaces)
        return true
    })

    ipcMain.handle('reorder-folders', (_, folderIds: string[]) => {
        const folders = (store.get('folders') || []) as WorkspaceFolder[]
        const reorderedFolders = folderIds
            .map(id => folders.find(f => f.id === id))
            .filter((f): f is WorkspaceFolder => f !== undefined)

        // Add any folders not in the list
        const remaining = folders.filter(f => !folderIds.includes(f.id))
        store.set('folders', [...reorderedFolders, ...remaining])
        return true
    })

    ipcMain.handle('create-playground', async () => {
        // Create a readable timestamp for the playground name
        const now = new Date()
        const timestamp = `${now.getMonth() + 1}-${now.getDate()} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        const playgroundName = `Playground ${timestamp}`
        const playgroundPath = path.join(app.getPath('downloads'), `playground-${now.getTime()}`)

        if (!existsSync(playgroundPath)) {
            mkdirSync(playgroundPath, { recursive: true })
        }

        const newWorkspace: Workspace = {
            id: uuidv4(),
            name: playgroundName,
            path: playgroundPath,
            sessions: [
                {
                    id: uuidv4(),
                    name: 'Main',
                    cwd: playgroundPath,
                    type: 'regular'
                }
            ],
            createdAt: Date.now(),
            isPlayground: true
        }

        const workspaces = store.get('workspaces') as Workspace[]
        store.set('workspaces', [...workspaces, newWorkspace])

        return newWorkspace
    })

    // Settings handlers
    ipcMain.handle('get-settings', () => {
        return store.get('settings')
    })

    ipcMain.handle('save-settings', (_, settings: UserSettings) => {
        store.set('settings', settings)
        return true
    })

    // Shell Path Validation
    ipcMain.handle('validate-shell-path', async (_, shellPath: string) => {
        try {
            // If it's an absolute path, check if file exists
            if (shellPath.startsWith('/')) {
                if (existsSync(shellPath)) {
                    return { valid: true, resolvedPath: shellPath }
                } else {
                    return { valid: false, error: `Shell not found at path: ${shellPath}` }
                }
            }
            // Otherwise, use 'which' to find the shell in PATH
            const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/zsh'
            const { stdout } = await execAsync(`${shell} -l -c "which ${shellPath}"`)
            const resolvedPath = stdout.trim()
            if (resolvedPath) {
                return { valid: true, resolvedPath }
            } else {
                return { valid: false, error: `Shell '${shellPath}' not found in PATH` }
            }
        } catch {
            return { valid: false, error: `Shell '${shellPath}' not found or not accessible` }
        }
    })

    // Validate editor path/command by actually opening it
    ipcMain.handle('validate-editor-path', async (_, editorPath: string, testDir?: string) => {
        try {
            // If no testDir provided, ask user to select one
            let targetDir = testDir
            if (!targetDir) {
                const result = await dialog.showOpenDialog({
                    properties: ['openDirectory'],
                    title: 'Select a folder to test the editor',
                    buttonLabel: 'Test with this folder'
                })
                if (result.canceled || result.filePaths.length === 0) {
                    return { valid: false, error: 'Test cancelled' }
                }
                targetDir = result.filePaths[0]
            }

            // Test by actually opening the selected directory
            const escapedCommand = editorPath.includes(' ') ? `${editorPath}` : editorPath
            await execWithShell(`${escapedCommand} "${targetDir}"`)
            return { valid: true, resolvedPath: editorPath }
        } catch (e: any) {
            return { valid: false, error: e.message || 'Failed to open editor' }
        }
    })

    // App Version
    ipcMain.handle('get-app-version', () => {
        return app.getVersion()
    })

    // Template handlers
    ipcMain.handle('get-templates', () => {
        return store.get('customTemplates') || []
    })

    ipcMain.handle('save-templates', (_, templates: any[]) => {
        store.set('customTemplates', templates)
        return true
    })

    ipcMain.handle('check-git-config', async () => {
        try {
            // First, check if git is installed
            try {
                await execWithShell('git --version')
            } catch (e) {
                console.error('Git is not installed:', e)
                return null
            }

            let username = ''
            let email = ''

            // Check username
            try {
                const result = await execWithShell('git config --global user.name')
                username = result.stdout.trim()
            } catch (e) {
                // Username not set - this is okay, we'll return empty string
            }

            // Check email
            try {
                const result = await execWithShell('git config --global user.email')
                email = result.stdout.trim()
            } catch (e) {
                // Email not set - this is okay, we'll return empty string
            }

            // Return null if both are empty (git is installed but not configured)
            if (!username && !email) {
                return null
            }

            return {
                username,
                email
            }
        } catch (e) {
            console.error('Git config check error:', e)
            return null
        }
    })

    // Git handlers
    ipcMain.handle('get-git-status', async (_, workspacePath: string) => {
        try {
            const git = simpleGit(workspacePath)
            const isRepo = await git.checkIsRepo()
            if (!isRepo) return null

            const status = await git.status()

            // Check if MERGE_HEAD exists (merge in progress)
            // This is more reliable than checking conflicted files
            // because conflicts can be resolved but merge not yet committed
            const mergeHeadPath = path.join(workspacePath, '.git', 'MERGE_HEAD')
            const isMerging = existsSync(mergeHeadPath)

            // Combine staged files with renamed files (git mv creates renamed but not in staged array)
            const renamedFiles = status.renamed.map(r => r.to)
            const allStaged = [...new Set([...status.staged, ...renamedFiles])]

            return {
                branch: status.current || 'unknown',
                modified: status.modified,
                staged: allStaged,  // Include renamed files in staged
                untracked: status.not_added,
                conflicted: status.conflicted,  // Merge conflict files
                deleted: status.deleted,        // Deleted files
                renamed: status.renamed.map(r => ({ from: r.from, to: r.to })),  // Renamed/moved files
                created: status.created,        // Newly created files
                ahead: status.ahead,
                behind: status.behind,
                isMerging  // True if MERGE_HEAD exists (merge in progress)
            }
        } catch (e) {
            console.error('Git status error:', e)
            return null
        }
    })

    ipcMain.handle('git-stage', async (_, workspacePath: string, file: string) => {
        try {
            const git = simpleGit(workspacePath)
            await git.add(file)
            return true
        } catch (e) {
            console.error('Git stage error:', e)
            throw e
        }
    })

    ipcMain.handle('git-stage-all', async (_, workspacePath: string) => {
        try {
            const git = simpleGit(workspacePath)
            await git.add('.')
            return true
        } catch (e) {
            console.error('Git stage all error:', e)
            throw e
        }
    })

    // Stage multiple files at once (avoids index.lock conflicts)
    ipcMain.handle('git-stage-files', async (_, workspacePath: string, files: string[]) => {
        try {
            const git = simpleGit(workspacePath)
            await git.add(files)
            return true
        } catch (e) {
            console.error('Git stage files error:', e)
            throw e
        }
    })

    ipcMain.handle('git-unstage', async (_, workspacePath: string, file: string) => {
        try {
            const git = simpleGit(workspacePath)
            await git.reset(['HEAD', file])
            return true
        } catch (e) {
            console.error('Git unstage error:', e)
            throw e
        }
    })

    ipcMain.handle('git-unstage-all', async (_, workspacePath: string) => {
        try {
            const git = simpleGit(workspacePath)
            await git.reset(['HEAD']) // Reset mixed (default) unstages everything
            return true
        } catch (e) {
            console.error('Git unstage all error:', e)
            throw e
        }
    })

    ipcMain.handle('git-commit', async (_, workspacePath: string, message: string) => {
        try {
            const git = simpleGit(workspacePath)
            await git.commit(message)
            return true
        } catch (e) {
            console.error('Git commit error:', e)
            throw e
        }
    })

    ipcMain.handle('git-push', async (_, workspacePath: string) => {
        try {
            const git = simpleGit(workspacePath)

            // Get current branch name
            const status = await git.status()
            const currentBranch = status.current

            // Check if upstream is set
            const tracking = status.tracking

            if (!tracking && currentBranch) {
                // No upstream set - push with --set-upstream
                console.log(`[git-push] No upstream for '${currentBranch}', setting upstream to origin/${currentBranch}`)
                await git.push(['--set-upstream', 'origin', currentBranch])
            } else {
                // Upstream exists - normal push
                await git.push()
            }

            return true
        } catch (e) {
            console.error('Git push error:', e)
            throw e
        }
    })

    ipcMain.handle('git-pull', async (_, workspacePath: string) => {
        try {
            const git = simpleGit(workspacePath)
            await git.pull()
            return true
        } catch (e) {
            console.error('Git pull error:', e)
            throw e
        }
    })

    ipcMain.handle('git-log', async (_, workspacePath: string, limit: number = 20) => {
        try {
            const git = simpleGit(workspacePath)
            const log = await git.log({ maxCount: limit })
            return log.all.map(commit => ({
                hash: commit.hash,
                message: commit.message,
                author: commit.author_name,
                date: commit.date
            }))
        } catch (e) {
            console.error('Git log error:', e)
            throw e
        }
    })

    ipcMain.handle('git-reset', async (_, workspacePath: string, commitHash: string, hard: boolean = false) => {
        try {
            const git = simpleGit(workspacePath)
            if (hard) {
                await git.reset(['--hard', commitHash])
            } else {
                await git.reset(['--soft', commitHash])
            }
            return true
        } catch (e) {
            console.error('Git reset error:', e)
            throw e
        }
    })

    ipcMain.handle('git-list-branches', async (_, workspacePath: string) => {
        try {
            const git = simpleGit(workspacePath)
            const isRepo = await git.checkIsRepo()
            if (!isRepo) return null

            const branchSummary = await git.branch()

            // Get worktree branches to mark them as unavailable for checkout
            let worktreeBranches: string[] = []
            try {
                const worktreeOutput = await git.raw(['worktree', 'list', '--porcelain'])
                // Parse worktree output to extract branch names
                // Format: worktree /path\nHEAD abc123\nbranch refs/heads/branch-name\n\n
                const lines = worktreeOutput.split('\n')
                for (const line of lines) {
                    if (line.startsWith('branch refs/heads/')) {
                        const branchName = line.replace('branch refs/heads/', '')
                        worktreeBranches.push(branchName)
                    }
                }
            } catch (worktreeErr) {
                // Worktree command might fail if not supported, ignore
                console.log('Could not get worktree list:', worktreeErr)
            }

            return {
                current: branchSummary.current,
                all: branchSummary.all,
                branches: branchSummary.branches,
                worktreeBranches // Branches that are checked out in worktrees
            }
        } catch (e) {
            console.error('Git list branches error:', e)
            throw e
        }
    })

    ipcMain.handle('git-checkout', async (_, workspacePath: string, branchName: string) => {
        try {
            const git = simpleGit(workspacePath)
            await git.checkout(branchName)
            return true
        } catch (e) {
            console.error('Git checkout error:', e)
            throw e
        }
    })

    // Git merge - merge local branches
    ipcMain.handle('git-merge', async (_, workspacePath: string, branchName: string): Promise<IPCResult<{ merged: boolean; conflicts?: string[]; alreadyUpToDate?: boolean; uncommittedChanges?: string[] }>> => {
        console.log('[git-merge] ========== START ==========')
        console.log('[git-merge] workspacePath:', workspacePath)
        console.log('[git-merge] branchName to merge:', branchName)

        try {
            const git = simpleGit(workspacePath)

            // Log current branch info before merge
            const beforeStatus = await git.status()
            console.log('[git-merge] Current branch:', beforeStatus.current)
            console.log('[git-merge] Is clean:', beforeStatus.isClean())
            console.log('[git-merge] Modified files:', beforeStatus.modified)
            console.log('[git-merge] Staged files:', beforeStatus.staged)

            // Check for uncommitted changes before merge
            if (!beforeStatus.isClean()) {
                const uncommittedFiles = [...beforeStatus.modified, ...beforeStatus.staged, ...beforeStatus.not_added]
                console.log('[git-merge] Uncommitted changes detected:', uncommittedFiles)
                return {
                    success: false,
                    error: `Cannot merge: You have uncommitted changes.\n\nModified files:\n${uncommittedFiles.join('\n')}\n\nPlease commit or stash your changes first.`,
                    errorType: 'UNKNOWN_ERROR',
                    data: { merged: false, uncommittedChanges: uncommittedFiles }
                }
            }

            // Check if branch exists
            const branches = await git.branch()
            console.log('[git-merge] Available branches:', branches.all)
            console.log('[git-merge] Branch exists:', branches.all.includes(branchName))

            // Execute merge
            console.log('[git-merge] Executing: git merge', branchName)
            const result = await git.merge([branchName])
            console.log('[git-merge] Merge result:', JSON.stringify(result, null, 2))

            // Check status after merge
            const afterStatus = await git.status()
            console.log('[git-merge] After merge - current branch:', afterStatus.current)
            console.log('[git-merge] After merge - conflicted:', afterStatus.conflicted)
            console.log('[git-merge] After merge - modified:', afterStatus.modified)

            // Check for conflicts
            if (result.failed) {
                console.log('[git-merge] Merge FAILED - conflicts detected')
                return {
                    success: false,
                    error: 'Merge conflict occurred',
                    errorType: 'UNKNOWN_ERROR',
                    data: { merged: false, conflicts: afterStatus.conflicted }
                }
            }

            // Check if nothing was merged (already up to date)
            const noChanges = result.summary.changes === 0 && result.summary.insertions === 0 && result.summary.deletions === 0
            if (noChanges) {
                console.log('[git-merge] No changes - Already up to date')
                console.log('[git-merge] ========== END ==========')
                return {
                    success: true,
                    data: { merged: true, alreadyUpToDate: true }
                }
            }

            console.log('[git-merge] Merge SUCCESS with changes')
            console.log('[git-merge] ========== END ==========')
            return { success: true, data: { merged: true, alreadyUpToDate: false } }
        } catch (e: any) {
            console.error('[git-merge] ERROR:', e.message)
            console.error('[git-merge] Full error:', e)
            // Handle conflict case
            if (e.message?.includes('CONFLICTS') || e.message?.includes('conflict')) {
                const git = simpleGit(workspacePath)
                const status = await git.status()
                console.log('[git-merge] Conflict detected via exception')
                console.log('[git-merge] Conflicted files:', status.conflicted)
                return {
                    success: false,
                    error: 'Merge conflict occurred',
                    errorType: 'UNKNOWN_ERROR',
                    data: { merged: false, conflicts: status.conflicted }
                }
            }
            return { success: false, error: e.message, errorType: 'UNKNOWN_ERROR' }
        }
    })

    // Git merge abort - cancel merge
    ipcMain.handle('git-merge-abort', async (_, workspacePath: string): Promise<IPCResult<void>> => {
        try {
            const git = simpleGit(workspacePath)
            await git.merge(['--abort'])
            return { success: true }
        } catch (e: any) {
            console.error('Git merge abort error:', e)
            return { success: false, error: e.message, errorType: 'UNKNOWN_ERROR' }
        }
    })

    // Git branch delete - delete local branch
    ipcMain.handle('git-delete-branch', async (_, workspacePath: string, branchName: string, force: boolean = false): Promise<IPCResult<void>> => {
        try {
            const git = simpleGit(workspacePath)
            // -d for merged branches only, -D for force delete
            const flag = force ? '-D' : '-d'
            await git.branch([flag, branchName])
            return { success: true }
        } catch (e: any) {
            console.error('Git delete branch error:', e)
            return { success: false, error: e.message, errorType: 'UNKNOWN_ERROR' }
        }
    })

    // GitHub CLI handlers
    ipcMain.handle('gh-check-auth', async () => {
        try {
            // gh auth status 명령어로 인증 상태 확인
            const { stdout } = await execWithShell('gh auth status')
            return { authenticated: true, message: stdout }
        } catch (e: any) {
            // 인증되지 않은 경우
            return { authenticated: false, message: e.message }
        }
    })

    ipcMain.handle('gh-auth-login', async () => {
        try {
            // gh auth login --web 으로 브라우저 인증
            const { stdout, stderr } = await execWithShell('gh auth login --web')
            return { success: true, message: stdout || stderr }
        } catch (e: any) {
            return { success: false, message: e.message }
        }
    })

    ipcMain.handle('gh-create-pr', async (_, workspacePath: string, title: string, body: string) => {
        try {
            const { stdout } = await execWithShell(`gh pr create --title "${title}" --body "${body}"`, { cwd: workspacePath })
            return { success: true, url: stdout.trim() }
        } catch (e: any) {
            console.error('GitHub PR creation error:', e)
            throw new Error(e.message)
        }
    })

    ipcMain.handle('gh-list-prs', async (_, workspacePath: string) => {
        try {
            const { stdout } = await execWithShell('gh pr list --json number,title,state,author,url', { cwd: workspacePath })
            return JSON.parse(stdout)
        } catch (e: any) {
            console.error('GitHub PR list error:', e)
            throw new Error(e.message)
        }
    })

    ipcMain.handle('gh-repo-view', async (_, workspacePath: string) => {
        try {
            const { stdout } = await execWithShell('gh repo view --json name,owner,url,description,defaultBranchRef', { cwd: workspacePath })
            return JSON.parse(stdout)
        } catch (e: any) {
            console.error('GitHub repo view error:', e)
            return null
        }
    })

    ipcMain.handle('gh-workflow-status', async (_, workspacePath: string) => {
        try {
            const { stdout } = await execWithShell('gh run list --json status,conclusion,name,headBranch,createdAt,url --limit 10', { cwd: workspacePath })
            return { success: true, data: JSON.parse(stdout) }
        } catch (e: any) {
            console.error('GitHub workflow status error:', e)
            return { success: false, error: e.message, errorType: 'UNKNOWN_ERROR' }
        }
    })

    // Worktree용 GitHub 기능
    ipcMain.handle('gh-push-branch', async (_, workspacePath: string, branchName: string): Promise<IPCResult<void>> => {
        try {
            // Check if gh is installed
            try {
                await execWithShell('gh --version')
            } catch {
                return { success: false, error: 'GitHub CLI not found', errorType: 'GH_CLI_NOT_FOUND' }
            }

            // Check auth status
            try {
                await execWithShell('gh auth status')
            } catch {
                return { success: false, error: 'Not authenticated with GitHub', errorType: 'GH_NOT_AUTHENTICATED' }
            }

            const git = simpleGit(workspacePath)
            // Push branch to origin
            await git.push('origin', branchName, ['--set-upstream'])
            return { success: true }
        } catch (e: any) {
            console.error('GitHub push error:', e)
            return { success: false, error: e.message, errorType: 'UNKNOWN_ERROR' }
        }
    })

    ipcMain.handle('gh-merge-pr', async (_, workspacePath: string, prNumber: number) => {
        try {
            const { stdout } = await execWithShell(`gh pr merge ${prNumber} --merge`, { cwd: workspacePath })
            return { success: true, message: stdout }
        } catch (e: any) {
            console.error('GitHub PR merge error:', e)
            throw new Error(e.message)
        }
    })

    ipcMain.handle('gh-create-pr-from-worktree', async (_, workspacePath: string, branchName: string, title: string, body: string): Promise<IPCResult<{ url: string }>> => {
        try {
            // Check if gh is installed
            try {
                await execWithShell('gh --version')
            } catch {
                return { success: false, error: 'GitHub CLI not found', errorType: 'GH_CLI_NOT_FOUND' }
            }

            // Check auth status
            try {
                await execWithShell('gh auth status')
            } catch {
                return { success: false, error: 'Not authenticated with GitHub', errorType: 'GH_NOT_AUTHENTICATED' }
            }

            // First, check if branch is pushed
            const git = simpleGit(workspacePath)
            const status = await git.status()

            if (status.ahead > 0) {
                // Push first
                await git.push('origin', branchName, ['--set-upstream'])
            }

            // Create PR
            const { stdout } = await execWithShell(`gh pr create --title "${title}" --body "${body}" --head "${branchName}"`, { cwd: workspacePath })
            return { success: true, data: { url: stdout.trim() } }
        } catch (e: any) {
            console.error('GitHub PR creation error:', e)
            return { success: false, error: e.message, errorType: 'UNKNOWN_ERROR' }
        }
    })

    // Open in Finder (cross-platform: Finder/Explorer/File Manager)
    // Shows the file selected in its parent folder
    ipcMain.handle('reveal-in-finder', async (_, filePath: string, baseCwd?: string) => {
        let resolvedPath = filePath

        // Expand ~ to home directory
        if (resolvedPath.startsWith('~/')) {
            resolvedPath = path.join(os.homedir(), resolvedPath.slice(2))
        } else if (resolvedPath === '~') {
            resolvedPath = os.homedir()
        }
        // Handle relative paths
        else if (baseCwd && !path.isAbsolute(resolvedPath)) {
            resolvedPath = path.resolve(baseCwd, resolvedPath)
        }

        // Check if file exists
        if (!existsSync(resolvedPath)) {
            console.error('[reveal-in-finder] File not found:', resolvedPath)
            return false
        }

        shell.showItemInFolder(resolvedPath)
        return true
    })

    // Directory selection dialog
    ipcMain.handle('select-directory', async () => {
        const result = await dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory']
        })

        if (result.canceled || result.filePaths.length === 0) {
            return null
        }

        return result.filePaths[0]
    })

    // Show native message box with custom icon (defaults to app logo)
    ipcMain.handle('show-message-box', async (_, options: { type: 'info' | 'warning' | 'error' | 'question'; title: string; message: string; detail?: string; buttons: string[]; icon?: string }) => {
        // Use provided icon or default to app logo
        const iconPath = options.icon ? path.resolve(options.icon) : logoIcon
        console.log('[showMessageBox] Icon path:', iconPath)
        console.log('[showMessageBox] File exists:', existsSync(iconPath))
        const dialogIcon = nativeImage.createFromPath(iconPath)
        console.log('[showMessageBox] Icon isEmpty:', dialogIcon.isEmpty())
        const result = await dialog.showMessageBox({
            type: options.type,
            title: options.title,
            message: options.message,
            detail: options.detail,
            buttons: options.buttons,
            icon: dialogIcon.isEmpty() ? undefined : dialogIcon
        })
        return result
    })

    // Open external URL in browser
    ipcMain.handle('open-external', async (_, url: string) => {
        try {
            await shell.openExternal(url)
            return { success: true }
        } catch (error: any) {
            console.error('[openExternal] Error:', error)
            return { success: false, error: error.message }
        }
    })

    // Search files in workspace
    ipcMain.handle('search-files', async (_, workspacePath: string, searchQuery: string) => {
        try {
            const maxResults = 100
            const excludeDirs = ['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.cache', 'coverage']
            const files: Array<{ path: string; relativePath: string; name: string }> = []

            const searchRecursive = (dir: string, basePath: string) => {
                if (files.length >= maxResults) return

                try {
                    const items = readdirSync(dir)

                    for (const item of items) {
                        if (files.length >= maxResults) break

                        const fullPath = path.join(dir, item)
                        const relativePath = path.relative(basePath, fullPath)

                        try {
                            const stat = statSync(fullPath)

                            if (stat.isDirectory()) {
                                // Skip excluded directories
                                if (!excludeDirs.includes(item) && !item.startsWith('.')) {
                                    searchRecursive(fullPath, basePath)
                                }
                            } else if (stat.isFile()) {
                                // Match against filename or relative path
                                const lowerQuery = searchQuery.toLowerCase()
                                const fileName = item.toLowerCase()
                                const relPath = relativePath.toLowerCase()

                                if (fileName.includes(lowerQuery) || relPath.includes(lowerQuery)) {
                                    files.push({
                                        path: fullPath,
                                        relativePath: relativePath,
                                        name: item
                                    })
                                }
                            }
                        } catch (e) {
                            // Skip files we can't access
                            continue
                        }
                    }
                } catch (e) {
                    // Skip directories we can't read
                    return
                }
            }

            if (searchQuery) {
                searchRecursive(workspacePath, workspacePath)
            }

            return { success: true, files }
        } catch (error: any) {
            console.error('[searchFiles] Error:', error)
            return { success: false, error: error.message, files: [] }
        }
    })

    // Search file contents in workspace (using bundled ripgrep, fallback to system ripgrep, then Node.js)
    ipcMain.handle('search-content', async (_, workspacePath: string, searchQuery: string) => {
        try {
            const maxResults = 200
            const excludeDirs = ['.git', 'node_modules', '.next', 'dist', 'build', '.turbo', '.cache', 'coverage']

            // Try bundled ripgrep first (fastest, always available)
            const tryRipgrep = async (rgCommand: string, method: string) => {
                const rgArgs = [
                    '--json',
                    '--max-count', '5',  // Max 5 matches per file
                    '--max-columns', '500',  // Avoid very long lines
                    '--no-heading',
                    '--line-number',
                    '--column',
                    '--smart-case',  // Case insensitive unless uppercase present
                    '--hidden',  // Include hidden files
                    ...excludeDirs.map(dir => `--glob=!${dir}/`),
                    searchQuery,
                    '.'  // Search in current directory (will use cwd option)
                ]

                const { stdout } = await execAsync(`"${rgCommand}" ${rgArgs.join(' ')}`, { cwd: workspacePath })

                const results: Array<{
                    path: string
                    relativePath: string
                    line: number
                    column: number
                    text: string
                    matches: Array<{ start: number; end: number }>
                }> = []

                // Parse ripgrep JSON output
                const lines = stdout.trim().split('\n')
                for (const line of lines) {
                    if (!line || results.length >= maxResults) break

                    try {
                        const data = JSON.parse(line)
                        if (data.type === 'match') {
                            const filePath = data.data.path.text
                            const lineNumber = data.data.line_number
                            const lineText = data.data.lines.text
                            const submatches = data.data.submatches || []

                            results.push({
                                path: path.join(workspacePath, filePath),
                                relativePath: filePath,
                                line: lineNumber,
                                column: submatches[0]?.start || 0,
                                text: lineText,  // Don't trim! Submatches use original text positions
                                matches: submatches.map((m: any) => ({
                                    start: m.start,
                                    end: m.end
                                }))
                            })
                        }
                    } catch (e) {
                        // Skip invalid JSON lines
                        continue
                    }
                }

                return { success: true, results, method }
            }

            // 1. Try bundled ripgrep (always available, fastest)
            try {
                const ripgrepPath = getRipgrepPath()
                console.log('[searchContent] Trying ripgrep:', ripgrepPath)
                console.log('[searchContent] File exists:', existsSync(ripgrepPath))
                return await tryRipgrep(ripgrepPath, 'ripgrep (bundled)')
            } catch (bundledError) {
                console.log('[searchContent] Bundled ripgrep failed:', bundledError)
                console.log('[searchContent] Trying system ripgrep')

                // 2. Try system ripgrep (if installed via brew)
                try {
                    const { stdout: rgVersion } = await execAsync('which rg')
                    const systemRgPath = rgVersion.trim()
                    console.log('[searchContent] Found system ripgrep:', systemRgPath)
                    return await tryRipgrep(systemRgPath, 'ripgrep (system)')
                } catch (systemError) {
                    // 3. Fallback to Node.js implementation
                    console.log('[searchContent] No ripgrep available, using Node.js fallback')

                const results: Array<{
                    path: string
                    relativePath: string
                    line: number
                    column: number
                    text: string
                    matches: Array<{ start: number; end: number }>
                }> = []

                const searchInFile = (filePath: string, basePath: string) => {
                    if (results.length >= maxResults) return

                    try {
                        const content = readFileSync(filePath, 'utf-8')
                        const lines = content.split('\n')
                        const lowerQuery = searchQuery.toLowerCase()

                        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                            const line = lines[i]
                            const lowerLine = line.toLowerCase()

                            if (lowerLine.includes(lowerQuery)) {
                                const column = lowerLine.indexOf(lowerQuery)
                                const matches = []
                                let pos = 0

                                // Find all occurrences in the line
                                while (pos < lowerLine.length && matches.length < 10) {
                                    const idx = lowerLine.indexOf(lowerQuery, pos)
                                    if (idx === -1) break
                                    matches.push({ start: idx, end: idx + searchQuery.length })
                                    pos = idx + searchQuery.length
                                }

                                results.push({
                                    path: filePath,
                                    relativePath: path.relative(basePath, filePath),
                                    line: i + 1,
                                    column,
                                    text: line.trim(),
                                    matches
                                })
                            }
                        }
                    } catch (e) {
                        // Skip files we can't read (binary, permission denied, etc.)
                        return
                    }
                }

                const searchRecursive = (dir: string, basePath: string) => {
                    if (results.length >= maxResults) return

                    try {
                        const items = readdirSync(dir)

                        for (const item of items) {
                            if (results.length >= maxResults) break

                            const fullPath = path.join(dir, item)

                            try {
                                const stat = statSync(fullPath)

                                if (stat.isDirectory()) {
                                    if (!excludeDirs.includes(item) && !item.startsWith('.')) {
                                        searchRecursive(fullPath, basePath)
                                    }
                                } else if (stat.isFile()) {
                                    // Skip binary files and very large files
                                    if (stat.size > 1024 * 1024) continue  // Skip files > 1MB

                                    // Skip known binary extensions
                                    const ext = path.extname(item).toLowerCase()
                                    const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.woff', '.woff2', '.ttf', '.eot', '.zip', '.tar', '.gz']
                                    if (binaryExts.includes(ext)) continue

                                    searchInFile(fullPath, basePath)
                                }
                            } catch (e) {
                                continue
                            }
                        }
                    } catch (e) {
                        return
                    }
                }

                if (searchQuery) {
                    searchRecursive(workspacePath, workspacePath)
                }

                    return { success: true, results, method: 'nodejs' }
                }
            }
        } catch (error: any) {
            console.error('[searchContent] Error:', error)
            return { success: false, error: error.message, results: [] }
        }
    })

    ipcMain.handle('check-tools', async () => {
        const tools = {
            git: false,
            gh: false,
            brew: false
        }

        try {
            await execWithShell('git --version')
            tools.git = true
        } catch (e) {
            console.log('Git not found')
        }

        try {
            await execWithShell('gh --version')
            tools.gh = true
        } catch (e) {
            console.log('GitHub CLI not found')
        }

        try {
            await execWithShell('brew --version')
            tools.brew = true
        } catch (e) {
            console.log('Homebrew not found')
        }

        return tools
    })

    // Editor open handler
    ipcMain.handle('open-in-editor', async (_, workspacePath: string, editorType?: string) => {
        try {
            const settings = store.get('settings') as UserSettings
            // Get default editor from settings if not specified
            const editor = editorType || settings?.defaultEditor || 'vscode'

            console.log('[open-in-editor] Editor type:', editor)
            console.log('[open-in-editor] Workspace path:', workspacePath)

            let command: string

            if (editor === 'custom') {
                // Use custom editor path from settings
                const customPath = settings?.customEditorPath
                console.log('[open-in-editor] Custom editor path:', customPath)
                if (!customPath) {
                    throw new Error('Custom editor path not configured')
                }
                // Trim whitespace to prevent issues with extra spaces
                command = customPath.trim()
            } else {
                // Map editor type to command
                const editorCommands: Record<string, string> = {
                    'vscode': 'code',
                    'cursor': 'cursor',
                    'antigravity': 'open -a "Antigravity"'
                }
                command = editorCommands[editor]
                if (!command) {
                    throw new Error(`Unknown editor type: ${editor}`)
                }
            }

            // Execute editor command using login shell (via execWithShell helper)
            // For 'open -a' commands, don't escape (already properly formatted)
            // For other commands, escape if they contain spaces
            const escapedCommand = command.startsWith('open -a')
                ? command
                : (command.includes(' ') ? `"${command}"` : command)

            const fullCommand = `${escapedCommand} .`
            console.log('[open-in-editor] Executing command:', fullCommand)
            console.log('[open-in-editor] Working directory:', workspacePath)

            await execWithShell(fullCommand, { cwd: workspacePath })

            console.log('[open-in-editor] Command executed successfully')
            return { success: true, editor }
        } catch (e: any) {
            console.error('[open-in-editor] ERROR:', e.message)
            console.error('[open-in-editor] Full error:', e)
            return { success: false, error: e.message }
        }
    })

    // Read file content for preview
    ipcMain.handle('read-file-content', async (
        _,
        filePath: string,
        maxSize: number = 500000  // 500KB limit
    ): Promise<{ success: boolean; content?: string; error?: string; size?: number }> => {
        try {
            if (!existsSync(filePath)) {
                return { success: false, error: 'File not found' }
            }

            const stats = statSync(filePath)
            if (stats.size > maxSize) {
                return { success: false, error: `File too large (${Math.round(stats.size / 1024)}KB)`, size: stats.size }
            }

            const content = readFileSync(filePath, 'utf-8')
            return { success: true, content, size: stats.size }
        } catch (e: any) {
            return { success: false, error: e.message }
        }
    })

    // Read image file as base64 for preview
    ipcMain.handle('read-image-as-base64', async (
        _,
        filePath: string,
        maxSize: number = 10000000  // 10MB limit for images
    ): Promise<{ success: boolean; data?: string; mimeType?: string; error?: string; size?: number }> => {
        try {
            if (!existsSync(filePath)) {
                return { success: false, error: 'File not found' }
            }

            const stats = statSync(filePath)
            if (stats.size > maxSize) {
                return { success: false, error: `Image too large (${Math.round(stats.size / 1024 / 1024)}MB)`, size: stats.size }
            }

            // Determine MIME type from extension
            const ext = path.extname(filePath).toLowerCase().slice(1)
            const mimeTypes: Record<string, string> = {
                'png': 'image/png',
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'gif': 'image/gif',
                'webp': 'image/webp',
                'svg': 'image/svg+xml',
                'ico': 'image/x-icon',
                'bmp': 'image/bmp'
            }
            const mimeType = mimeTypes[ext] || 'image/png'

            const buffer = readFileSync(filePath)
            const base64 = buffer.toString('base64')

            return { success: true, data: base64, mimeType, size: stats.size }
        } catch (e: any) {
            return { success: false, error: e.message }
        }
    })

    // Open specific file in editor (with optional line/column)
    // Used for Cmd+Click on file paths in terminal
    ipcMain.handle('open-file-in-editor', async (
        _,
        filePath: string,
        baseCwd: string,
        line?: number,
        column?: number
    ): Promise<{ success: boolean; error?: string }> => {
        console.log('[open-file-in-editor] ===== START =====')
        console.log('[open-file-in-editor] Input:', { filePath, baseCwd, line, column })

        try {
            const settings = store.get('settings') as UserSettings
            const editor = settings?.defaultEditor || 'vscode'

            // 1. Resolve path - try multiple strategies
            let absolutePath = filePath
            let found = false

            // Strategy 0: Expand ~ to home directory
            if (absolutePath.startsWith('~/')) {
                absolutePath = path.join(os.homedir(), absolutePath.slice(2))
            } else if (absolutePath === '~') {
                absolutePath = os.homedir()
            }

            // Strategy 1: If absolute path (including expanded ~), check if exists
            if (path.isAbsolute(absolutePath)) {
                console.log('[open-file-in-editor] Path is absolute, checking if exists...')
                console.log('[open-file-in-editor] File exists?', existsSync(absolutePath))
                if (existsSync(absolutePath)) {
                    found = true
                    console.log('[open-file-in-editor] ✓ Found with Strategy 1 (absolute path)')
                } else {
                    // Strategy 2: Treat as project-root relative (e.g., /jcon/api/... -> cwd/jcon/api/...)
                    const cwdRelative = path.join(baseCwd, absolutePath)
                    console.log('[open-file-in-editor] Trying Strategy 2 (cwd relative):', cwdRelative)
                    console.log('[open-file-in-editor] File exists?', existsSync(cwdRelative))
                    if (existsSync(cwdRelative)) {
                        absolutePath = cwdRelative
                        found = true
                        console.log('[open-file-in-editor] ✓ Found with Strategy 2')
                    }
                }
            } else {
                // Strategy 3: Relative path from cwd
                absolutePath = path.resolve(baseCwd, absolutePath)
                console.log('[open-file-in-editor] Trying Strategy 3 (resolve):', absolutePath)
                found = existsSync(absolutePath)
                console.log('[open-file-in-editor] File exists?', found)
                if (found) {
                    console.log('[open-file-in-editor] ✓ Found with Strategy 3')
                }
            }

            // 2. Check if file exists
            if (!found) {
                console.log('[open-file-in-editor] ✗ File not found!')
                return { success: false, error: `File not found: ${filePath}` }
            }

            console.log('[open-file-in-editor] Final absolutePath:', absolutePath)

            // 3. Get editor command
            let command: string
            if (editor === 'custom') {
                const customPath = settings?.customEditorPath
                if (!customPath) {
                    return { success: false, error: 'Custom editor path not configured' }
                }
                command = customPath
            } else {
                const editorCommands: Record<string, string> = {
                    'vscode': 'code',
                    'cursor': 'cursor',
                    'antigravity': 'antigravity'
                }
                command = editorCommands[editor]
                if (!command) {
                    return { success: false, error: `Unknown editor: ${editor}` }
                }
            }

            // 4. Build command with project folder + file
            // VSCode, Cursor support: code /project -g file:line:column
            const escapedPath = absolutePath.replace(/'/g, "'\\''")
            const escapedCwd = baseCwd.replace(/'/g, "'\\''")

            let fullCommand: string
            if (!command.startsWith('open -a')) {
                // Editors like VSCode/Cursor: open project folder + goto file:line
                if (line) {
                    const location = column
                        ? `${absolutePath}:${line}:${column}`
                        : `${absolutePath}:${line}`
                    const escapedLocation = location.replace(/'/g, "'\\''")
                    fullCommand = `${command} '${escapedCwd}' -g '${escapedLocation}'`
                } else {
                    fullCommand = `${command} '${escapedCwd}' '${escapedPath}'`
                }
            } else {
                // For 'open -a' commands: open project folder, then file
                fullCommand = `${command} '${escapedCwd}' '${escapedPath}'`
            }

            console.log('[open-file-in-editor] Executing:', fullCommand)
            await execWithShell(fullCommand)

            return { success: true }
        } catch (e: any) {
            console.error('[open-file-in-editor] Error:', e.message)
            return { success: false, error: e.message }
        }
    })

    // ============================================
    // Lemon Squeezy License Handlers (using LicenseManager)
    // ============================================

    // Activate license with Lemon Squeezy
    ipcMain.handle('license-activate', async (_, licenseKey: string): Promise<IPCResult<LicenseData>> => {
        return licenseManager.activate(licenseKey)
    })

    // Validate existing license
    ipcMain.handle('license-validate', async (): Promise<IPCResult<LicenseData>> => {
        return licenseManager.validate()
    })

    // Deactivate license
    ipcMain.handle('license-deactivate', async (): Promise<IPCResult<void>> => {
        return licenseManager.deactivate()
    })

    // Check if license exists (without validation)
    ipcMain.handle('license-check', async (): Promise<IPCResult<{ hasLicense: boolean }>> => {
        return {
            success: true,
            data: { hasLicense: licenseManager.hasLicense() }
        }
    })

    // Get full license info including plan type and limits
    ipcMain.handle('license-get-info', async (): Promise<IPCResult<LicenseInfo>> => {
        const info = licenseManager.getLicenseInfo()
        return { success: true, data: info }
    })

    // Migrate legacy licenses (called on app start)
    licenseManager.migrateLegacyLicense()

    createWindow()

    app.on('activate', function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (isBackgroundMode) {
            // Exit background mode when dock icon is clicked
            showFromBackground()
        } else if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
    // In background mode, don't quit
    if (isBackgroundMode) {
        return
    }
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

// Handle app quit request (Cmd+Q or close button)
app.on('before-quit', async (event) => {
    // If already confirmed to quit, proceed
    if (isQuitting) {
        return
    }

    // Check if there are active terminals
    const terminalCount = terminalManager.getTerminalCount()
    if (terminalCount === 0) {
        // No active terminals — just quit. Session IDs preserved for resume.
        // validateCliSessionIds() on next startup cleans up stale ones.
        return
    }

    // Get count of terminals with running processes
    const runningCount = terminalManager.getRunningProcessCount()

    // Prevent quit to show dialog
    event.preventDefault()

    const dialogIcon = nativeImage.createFromPath(logoIcon)
    let message: string
    if (runningCount > 0) {
        message = `${runningCount} of ${terminalCount} terminal(s) have running processes.`
    } else {
        message = `There are ${terminalCount} active terminal(s).`
    }

    const { response } = await dialog.showMessageBox({
        type: 'question',
        title: 'Quit CLI Manager',
        message: message,
        detail: 'What would you like to do?',
        buttons: ['Keep Running in Background', 'Terminate All & Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 2,
        icon: dialogIcon.isEmpty() ? undefined : dialogIcon
    })

    if (response === 0) {
        // Keep running in background
        enterBackgroundMode()
    } else if (response === 1) {
        // Session IDs preserved — validateCliSessionIds() cleans up on next startup
        isQuitting = true
        terminalManager.killAll()
        // Quit after a short delay to ensure cleanup (use quit() not exit() for proper cleanup)
        setTimeout(() => {
            app.quit()
        }, 100)
    }
    // Cancel (2) - do nothing, stay open
})

/**
 * Create system tray icon with context menu
 */
function createTray(): void {
    if (tray) return  // Already exists

    const trayIcon = nativeImage.createFromPath(icon)
    // Resize for tray (16x16 is standard for macOS menu bar)
    const resizedIcon = trayIcon.resize({ width: 16, height: 16 })
    resizedIcon.setTemplateImage(true)  // Makes it adapt to dark/light menu bar

    tray = new Tray(resizedIcon)
    tray.setToolTip('CLI Manager - Running in background')

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show CLI Manager',
            click: () => {
                showFromBackground()
            }
        },
        { type: 'separator' },
        {
            label: `${terminalManager.getTerminalCount()} Terminal(s) Active`,
            enabled: false
        },
        { type: 'separator' },
        {
            label: 'Quit',
            click: () => {
                isQuitting = true
                terminalManager.killAll()
                app.quit()
            }
        }
    ])

    tray.setContextMenu(contextMenu)

    // Click on tray icon shows the app
    tray.on('click', () => {
        showFromBackground()
    })
}

/**
 * Enter background mode - hide window and show tray
 */
function enterBackgroundMode(): void {
    isBackgroundMode = true
    createTray()

    // Hide all windows
    BrowserWindow.getAllWindows().forEach(win => {
        win.hide()
    })

    // On macOS, hide dock icon when in background
    if (process.platform === 'darwin' && app.dock) {
        app.dock.hide()
    }

    console.log('[Background Mode] Entered - terminals still running')
}

/**
 * Exit background mode - show window and remove tray
 */
function showFromBackground(): void {
    isBackgroundMode = false

    // Show dock icon on macOS
    if (process.platform === 'darwin' && app.dock) {
        app.dock.show()
    }

    // Show windows
    const windows = BrowserWindow.getAllWindows()
    if (windows.length === 0) {
        createWindow()
    } else {
        windows.forEach(win => {
            win.show()
            win.focus()
        })
    }

    // Remove tray
    if (tray) {
        tray.destroy()
        tray = null
    }

    console.log('[Background Mode] Exited - window restored')
}

// In this file you can include the rest of your app"s specific main process
// code. You can also put them in separate files and require them here.

// ============================================
// Auto Updater 이벤트 핸들러
// ============================================

// Helper to send update status to all windows
function sendUpdateStatus(status: string, data?: any) {
    BrowserWindow.getAllWindows().forEach(win => {
        win.webContents.send('update-status', { status, ...data })
    })
}

autoUpdater.on('checking-for-update', () => {
    console.log('Checking for update...')
    sendUpdateStatus('checking')
})

autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version)
    sendUpdateStatus('available', { version: info.version })
})

autoUpdater.on('update-not-available', () => {
    console.log('Already up to date.')
    sendUpdateStatus('not-available')
})

autoUpdater.on('download-progress', (progress) => {
    console.log(`Download progress: ${Math.round(progress.percent)}%`)
    sendUpdateStatus('downloading', { percent: Math.round(progress.percent) })
})

autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version)
    sendUpdateStatus('ready', { version: info.version })
})

autoUpdater.on('error', (err) => {
    console.error('Update error:', err)
    sendUpdateStatus('error', { message: err.message })
})

// IPC handlers for manual update control
ipcMain.handle('check-for-update', async () => {
    // In dev mode, auto-updater doesn't work properly
    if (is.dev) {
        return { success: false, error: 'dev-mode', isDev: true }
    }

    try {
        console.log('Checking for updates...')
        console.log('Current version:', app.getVersion())

        const result = await autoUpdater.checkForUpdates()
        const currentVersion = app.getVersion()
        const latestVersion = result?.updateInfo?.version

        console.log('Latest version:', latestVersion)
        console.log('Update info:', JSON.stringify(result?.updateInfo, null, 2))

        if (latestVersion && latestVersion !== currentVersion) {
            return { success: true, version: latestVersion, hasUpdate: true }
        } else {
            return { success: true, version: currentVersion, hasUpdate: false }
        }
    } catch (error: any) {
        console.error('Update check error:', error)
        console.error('Error stack:', error.stack)
        return { success: false, error: error.message }
    }
})

// Download update manually (user clicks "Download" button)
ipcMain.handle('download-update', async () => {
    try {
        await autoUpdater.downloadUpdate()
        return { success: true }
    } catch (error: any) {
        console.error('Download update error:', error)
        return { success: false, error: error.message }
    }
})

ipcMain.handle('install-update', () => {
    // Set isQuitting flag to skip before-quit dialog
    isQuitting = true
    // Clean up all terminals before installing update
    terminalManager.killAll()
    // Install and restart with update
    autoUpdater.quitAndInstall()
})
