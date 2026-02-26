import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { Workspace, TerminalSession, UserSettings, IPCResult, LicenseData, LicenseInfo, SystemInfo } from '../shared/types'

// Custom APIs for renderer
const api = {
    getWorkspaces: (): Promise<Workspace[]> => ipcRenderer.invoke('get-workspaces'),
    syncWorktreeWorkspaces: (): Promise<IPCResult<{ imported: number; removed: number; updated: number }>> =>
        ipcRenderer.invoke('sync-worktree-workspaces'),
    addWorkspace: (): Promise<IPCResult<Workspace> | null> => ipcRenderer.invoke('add-workspace'),
    addSession: (workspaceId: string, type: 'regular' | 'worktree', branchName?: string, initialCommand?: string, sessionName?: string): Promise<IPCResult<TerminalSession> | null> => ipcRenderer.invoke('add-session', workspaceId, type, branchName, initialCommand, sessionName),
    addWorktreeWorkspace: (parentWorkspaceId: string, branchName: string): Promise<IPCResult<Workspace>> => ipcRenderer.invoke('add-worktree-workspace', parentWorkspaceId, branchName),
    removeWorkspace: (id: string, deleteBranch?: boolean): Promise<boolean> => ipcRenderer.invoke('remove-workspace', id, deleteBranch ?? true),
    removeSession: (workspaceId: string, sessionId: string): Promise<boolean> => ipcRenderer.invoke('remove-session', workspaceId, sessionId),
    renameSession: (workspaceId: string, sessionId: string, newName: string): Promise<boolean> => ipcRenderer.invoke('rename-session', workspaceId, sessionId, newName),
    reorderSessions: (workspaceId: string, sessionIds: string[]): Promise<boolean> => ipcRenderer.invoke('reorder-sessions', workspaceId, sessionIds),
    reorderWorkspaces: (workspaceIds: string[]): Promise<boolean> => ipcRenderer.invoke('reorder-workspaces', workspaceIds),
    togglePinWorkspace: (workspaceId: string): Promise<boolean> => ipcRenderer.invoke('toggle-pin-workspace', workspaceId),
    createPlayground: (): Promise<Workspace | null> => ipcRenderer.invoke('create-playground'),

    // Settings
    getSettings: (): Promise<UserSettings> => ipcRenderer.invoke('get-settings'),
    saveSettings: (settings: UserSettings): Promise<boolean> => ipcRenderer.invoke('save-settings', settings),
    checkGitConfig: (): Promise<{ username: string; email: string } | null> => ipcRenderer.invoke('check-git-config'),
    checkTools: (): Promise<{ git: boolean; gh: boolean; brew: boolean }> => ipcRenderer.invoke('check-tools'),
    getAppVersion: (): Promise<string> => ipcRenderer.invoke('get-app-version'),

    // Templates
    getTemplates: (): Promise<any[]> => ipcRenderer.invoke('get-templates'),
    saveTemplates: (templates: any[]): Promise<boolean> => ipcRenderer.invoke('save-templates', templates),

    // Split Terminal View
    openFullscreenTerminal: (sessionIds: string[]): Promise<boolean> => ipcRenderer.invoke('open-fullscreen-terminal', sessionIds),
    syncGridSessions: (sessionIds: string[]): Promise<boolean> => ipcRenderer.invoke('sync-grid-sessions', sessionIds),
    onGridSessionsUpdated: (callback: (sessionIds: string[]) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, sessionIds: string[]) => callback(sessionIds)
        ipcRenderer.on('grid-sessions-updated', handler)
        return () => ipcRenderer.removeListener('grid-sessions-updated', handler)
    },
    onGridViewStateChanged: (callback: (isOpen: boolean, sessionIds: string[]) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, isOpen: boolean, sessionIds: string[]) => callback(isOpen, sessionIds)
        ipcRenderer.on('grid-view-state-changed', handler)
        return () => ipcRenderer.removeListener('grid-view-state-changed', handler)
    },

    // Git
    getGitStatus: (workspacePath: string): Promise<any> => ipcRenderer.invoke('get-git-status', workspacePath),
    gitStage: (workspacePath: string, file: string): Promise<boolean> => ipcRenderer.invoke('git-stage', workspacePath, file),
    gitStageFiles: (workspacePath: string, files: string[]): Promise<boolean> => ipcRenderer.invoke('git-stage-files', workspacePath, files),
    gitStageAll: (workspacePath: string): Promise<boolean> => ipcRenderer.invoke('git-stage-all', workspacePath),
    gitUnstage: (workspacePath: string, file: string): Promise<boolean> => ipcRenderer.invoke('git-unstage', workspacePath, file),
    gitUnstageAll: (workspacePath: string): Promise<boolean> => ipcRenderer.invoke('git-unstage-all', workspacePath),
    gitCommit: (workspacePath: string, message: string): Promise<boolean> => ipcRenderer.invoke('git-commit', workspacePath, message),
    gitPush: (workspacePath: string): Promise<boolean> => ipcRenderer.invoke('git-push', workspacePath),
    gitPull: (workspacePath: string): Promise<boolean> => ipcRenderer.invoke('git-pull', workspacePath),
    gitLog: (workspacePath: string, limit?: number): Promise<any[]> => ipcRenderer.invoke('git-log', workspacePath, limit),
    gitReset: (workspacePath: string, commitHash: string, hard?: boolean): Promise<boolean> => ipcRenderer.invoke('git-reset', workspacePath, commitHash, hard),
    gitListBranches: (workspacePath: string): Promise<{ current: string; all: string[]; branches: any; worktreeBranches: string[] } | null> => ipcRenderer.invoke('git-list-branches', workspacePath),
    gitCheckout: (workspacePath: string, branchName: string): Promise<boolean> => ipcRenderer.invoke('git-checkout', workspacePath, branchName),
    gitMerge: (workspacePath: string, branchName: string): Promise<{ success: boolean; data?: { merged: boolean; conflicts?: string[] }; error?: string }> => ipcRenderer.invoke('git-merge', workspacePath, branchName),
    gitMergeAbort: (workspacePath: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('git-merge-abort', workspacePath),
    gitDeleteBranch: (workspacePath: string, branchName: string, force?: boolean): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('git-delete-branch', workspacePath, branchName, force),

    // GitHub CLI
    ghCheckAuth: (): Promise<{ authenticated: boolean; message: string }> => ipcRenderer.invoke('gh-check-auth'),
    ghAuthLogin: (): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke('gh-auth-login'),
    ghCreatePR: (workspacePath: string, title: string, body: string): Promise<{ success: boolean; url: string }> => ipcRenderer.invoke('gh-create-pr', workspacePath, title, body),
    ghListPRs: (workspacePath: string): Promise<any[]> => ipcRenderer.invoke('gh-list-prs', workspacePath),
    ghRepoView: (workspacePath: string): Promise<any> => ipcRenderer.invoke('gh-repo-view', workspacePath),
    ghWorkflowStatus: (workspacePath: string): Promise<any[]> => ipcRenderer.invoke('gh-workflow-status', workspacePath),
    ghPushBranch: (workspacePath: string, branchName: string): Promise<{ success: boolean }> => ipcRenderer.invoke('gh-push-branch', workspacePath, branchName),
    ghMergePR: (workspacePath: string, prNumber: number): Promise<{ success: boolean; message: string }> => ipcRenderer.invoke('gh-merge-pr', workspacePath, prNumber),
    ghCreatePRFromWorktree: (workspacePath: string, branchName: string, title: string, body: string): Promise<{ success: boolean; url: string }> => ipcRenderer.invoke('gh-create-pr-from-worktree', workspacePath, branchName, title, body),

    // Editor
    openInEditor: (workspacePath: string, editorType?: string): Promise<{ success: boolean; editor?: string; error?: string }> => ipcRenderer.invoke('open-in-editor', workspacePath, editorType),
    openFileInEditor: (filePath: string, baseCwd: string, line?: number, column?: number): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('open-file-in-editor', filePath, baseCwd, line, column),

    // Dialog
    selectDirectory: (): Promise<string | null> => ipcRenderer.invoke('select-directory'),
    revealInFinder: (filePath: string, baseCwd?: string): Promise<boolean> => ipcRenderer.invoke('reveal-in-finder', filePath, baseCwd),
    showMessageBox: (options: { type: 'info' | 'warning' | 'error' | 'question'; title: string; message: string; detail?: string; buttons: string[]; icon?: string }): Promise<{ response: number }> => ipcRenderer.invoke('show-message-box', options),
    openExternal: (url: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke('open-external', url),

    // Terminal
    createTerminal: (id: string, cwd: string, cols: number, rows: number, shell?: string): Promise<boolean> => ipcRenderer.invoke('terminal-create', id, cwd, cols, rows, shell),
    resizeTerminal: (id: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke('terminal-resize', id, cols, rows),
    killTerminal: (id: string): Promise<void> => ipcRenderer.invoke('terminal-kill', id),
    hasRunningProcess: (id: string): Promise<boolean> => ipcRenderer.invoke('terminal-has-running-process', id),
    getTerminalPreview: (id: string, lineCount?: number): Promise<string[]> => ipcRenderer.invoke('terminal-get-preview', id, lineCount ?? 5),
    writeTerminal: (id: string, data: string): void => ipcRenderer.send('terminal-input', id, data),
    onTerminalData: (id: string, callback: (data: string) => void): () => void => {
        const channel = `terminal-output-${id}`
        const listener = (_: any, data: string) => callback(data)
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.removeListener(channel, listener)
    },

    // CLI Session Tracking
    onCliSessionDetected: (callback: (data: { workspaceId: string; sessionId: string; cliSessionId: string; cliToolName: string }) => void): () => void => {
        const handler = (_event: Electron.IpcRendererEvent, data: any) => callback(data)
        ipcRenderer.on('cli-session-detected', handler)
        return () => ipcRenderer.removeListener('cli-session-detected', handler)
    },
    updateSessionCliInfo: (workspaceId: string, sessionId: string, cliSessionId: string, cliToolName: string): Promise<boolean> =>
        ipcRenderer.invoke('update-session-cli-info', workspaceId, sessionId, cliSessionId, cliToolName),
    clearSessionCliInfo: (workspaceId: string, sessionId: string): Promise<boolean> =>
        ipcRenderer.invoke('clear-session-cli-info', workspaceId, sessionId),
    rewriteCliCommand: (command: string): Promise<{ command: string; cliSessionId: string; cliToolName: string } | null> =>
        ipcRenderer.invoke('rewrite-cli-command', command),

    // System Monitor
    getSystemInfo: (): Promise<SystemInfo> => ipcRenderer.invoke('get-system-info'),

    // Ports
    onPortUpdate: (callback: (ports: any[]) => void): () => void => {
        const listener = (_: any, ports: any[]) => callback(ports)
        ipcRenderer.on('port-update', listener)
        return () => ipcRenderer.removeListener('port-update', listener)
    },
    killProcess: (pid: number): Promise<boolean> => ipcRenderer.invoke('kill-process', pid),
    refreshPorts: (): Promise<boolean> => ipcRenderer.invoke('refresh-ports'),

    // Terminal Zoom (Cmd+/- 이벤트 수신)
    onTerminalZoom: (callback: (key: string) => void): () => void => {
        const listener = (_: any, key: string) => callback(key)
        ipcRenderer.on('terminal-zoom', listener)
        return () => ipcRenderer.removeListener('terminal-zoom', listener)
    },

    // Terminal Clear (Cmd+K 이벤트 수신)
    clearTerminal: (id: string): void => ipcRenderer.send('terminal-clear', id),
    onTerminalClear: (id: string, callback: () => void): () => void => {
        const channel = `terminal-clear-${id}`
        const listener = () => callback()
        ipcRenderer.on(channel, listener)
        return () => ipcRenderer.removeListener(channel, listener)
    },

    // UI Zoom (전체 UI 줌 조정)
    zoomUi: (action: 'in' | 'out' | 'reset'): void => {
        ipcRenderer.send('zoom-ui', action)
    },

    // License
    licenseActivate: (licenseKey: string): Promise<IPCResult<LicenseData>> =>
        ipcRenderer.invoke('license-activate', licenseKey),
    licenseValidate: (): Promise<IPCResult<LicenseData>> =>
        ipcRenderer.invoke('license-validate'),
    licenseDeactivate: (): Promise<IPCResult<void>> =>
        ipcRenderer.invoke('license-deactivate'),
    licenseCheck: (): Promise<IPCResult<{ hasLicense: boolean }>> =>
        ipcRenderer.invoke('license-check'),
    licenseGetInfo: (): Promise<IPCResult<LicenseInfo>> =>
        ipcRenderer.invoke('license-get-info'),

    // Shell Validation
    validateShellPath: (shellPath: string): Promise<{ valid: boolean; resolvedPath?: string; error?: string }> =>
        ipcRenderer.invoke('validate-shell-path', shellPath),

    // Editor Validation (opens folder picker if testDir not provided)
    validateEditorPath: (editorPath: string, testDir?: string): Promise<{ valid: boolean; resolvedPath?: string; error?: string }> =>
        ipcRenderer.invoke('validate-editor-path', editorPath, testDir),

    // Updates
    checkForUpdate: (): Promise<{ success: boolean; version?: string; hasUpdate?: boolean; error?: string }> =>
        ipcRenderer.invoke('check-for-update'),
    downloadUpdate: (): Promise<{ success: boolean; error?: string }> =>
        ipcRenderer.invoke('download-update'),
    installUpdate: (): Promise<void> =>
        ipcRenderer.invoke('install-update'),
    onUpdateStatus: (callback: (status: { status: string; version?: string; percent?: number; message?: string }) => void): () => void => {
        const listener = (_: any, data: any) => callback(data)
        ipcRenderer.on('update-status', listener)
        return () => ipcRenderer.removeListener('update-status', listener)
    },

    // File utilities (for drag & drop)
    // Electron 9.0+ requires webUtils.getPathForFile() instead of file.path
    getFilePath: (file: File): string => webUtils.getPathForFile(file),

    // File Search
    searchFiles: (workspacePath: string, searchQuery: string): Promise<{ success: boolean; files: Array<{ path: string; relativePath: string; name: string }>; error?: string }> =>
        ipcRenderer.invoke('search-files', workspacePath, searchQuery),
    searchContent: (workspacePath: string, searchQuery: string): Promise<{
        success: boolean;
        results: Array<{
            path: string;
            relativePath: string;
            line: number;
            column: number;
            text: string;
            matches: Array<{ start: number; end: number }>
        }>;
        method?: string;
        error?: string
    }> =>
        ipcRenderer.invoke('search-content', workspacePath, searchQuery),
    readFileContent: (filePath: string, maxSize?: number): Promise<{
        success: boolean;
        content?: string;
        error?: string;
        size?: number
    }> =>
        ipcRenderer.invoke('read-file-content', filePath, maxSize),
    readImageAsBase64: (filePath: string, maxSize?: number): Promise<{
        success: boolean;
        data?: string;
        mimeType?: string;
        error?: string;
        size?: number
    }> =>
        ipcRenderer.invoke('read-image-as-base64', filePath, maxSize)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
    try {
        contextBridge.exposeInMainWorld('electron', electronAPI)
        contextBridge.exposeInMainWorld('api', api)
    } catch (error) {
        console.error(error)
    }
} else {
    // @ts-ignore (define in dts)
    window.electron = electronAPI
    // @ts-ignore (define in dts)
    window.api = api
}
