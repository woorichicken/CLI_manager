import { ElectronAPI } from '@electron-toolkit/preload'
import { Workspace, TerminalSession, UserSettings, IPCResult, LicenseData, LicenseInfo, SystemInfo, WorkspaceFolder } from '../shared/types'

declare global {
    interface Window {
        electron: ElectronAPI
        api: {
            getWorkspaces: () => Promise<Workspace[]>
            syncWorktreeWorkspaces: () => Promise<IPCResult<{ imported: number; removed: number; updated: number }>>
            addWorkspace: () => Promise<IPCResult<Workspace> | null>
            addSession: (workspaceId: string, type: 'regular' | 'worktree', branchName?: string, initialCommand?: string, sessionName?: string) => Promise<IPCResult<TerminalSession> | null>
            addWorktreeWorkspace: (parentWorkspaceId: string, branchName: string) => Promise<IPCResult<Workspace>>
            removeWorkspace: (id: string, deleteBranch?: boolean) => Promise<boolean>
            removeSession: (workspaceId: string, sessionId: string) => Promise<boolean>
            renameSession: (workspaceId: string, sessionId: string, newName: string) => Promise<boolean>
            reorderSessions: (workspaceId: string, sessionIds: string[]) => Promise<boolean>
            updateSessionMemo: (workspaceId: string, sessionId: string, memo: string) => Promise<boolean>
            reorderWorkspaces: (workspaceIds: string[]) => Promise<boolean>
            togglePinWorkspace: (workspaceId: string) => Promise<boolean>
            getFolders: () => Promise<WorkspaceFolder[]>
            createFolder: (name: string) => Promise<WorkspaceFolder>
            renameFolder: (folderId: string, newName: string) => Promise<boolean>
            removeFolder: (folderId: string) => Promise<boolean>
            toggleFolderExpanded: (folderId: string) => Promise<boolean>
            moveWorkspaceToFolder: (workspaceId: string, folderId: string | null) => Promise<boolean>
            reorderFolders: (folderIds: string[]) => Promise<boolean>
            createPlayground: () => Promise<Workspace | null>

            // Settings
            getSettings: () => Promise<UserSettings>
            saveSettings: (settings: UserSettings) => Promise<boolean>
            checkGitConfig: () => Promise<{ username: string; email: string } | null>

            // Dialog
            selectDirectory: () => Promise<string | null>
            revealInFinder: (filePath: string, baseCwd?: string) => Promise<boolean>
            showMessageBox: (options: { type: 'info' | 'warning' | 'error' | 'question'; title: string; message: string; detail?: string; buttons: string[]; icon?: string }) => Promise<{ response: number }>
            openExternal: (url: string) => Promise<{ success: boolean; error?: string }>

            // Templates
            getTemplates: () => Promise<any[]>
            saveTemplates: (templates: any[]) => Promise<boolean>

            // Split Terminal View
            openFullscreenTerminal: (sessionIds: string[]) => Promise<boolean>
            syncGridSessions: (sessionIds: string[]) => Promise<boolean>
            onGridSessionsUpdated: (callback: (sessionIds: string[]) => void) => () => void
            onGridViewStateChanged: (callback: (isOpen: boolean, sessionIds: string[]) => void) => () => void

            // Git
            getGitStatus: (workspacePath: string) => Promise<any>
            gitStage: (workspacePath: string, file: string) => Promise<boolean>
            gitStageFiles: (workspacePath: string, files: string[]) => Promise<boolean>
            gitStageAll: (workspacePath: string) => Promise<boolean>
            gitUnstage: (workspacePath: string, file: string) => Promise<boolean>
            gitUnstageAll: (workspacePath: string) => Promise<boolean>
            gitCommit: (workspacePath: string, message: string) => Promise<boolean>
            gitPush: (workspacePath: string) => Promise<boolean>
            gitPull: (workspacePath: string) => Promise<boolean>
            gitLog: (workspacePath: string, limit?: number) => Promise<any[]>
            gitReset: (workspacePath: string, commitHash: string, hard?: boolean) => Promise<boolean>
            gitListBranches: (workspacePath: string) => Promise<{ current: string; all: string[]; branches: any; worktreeBranches: string[] } | null>
            gitCheckout: (workspacePath: string, branchName: string) => Promise<boolean>
            gitMerge: (workspacePath: string, branchName: string) => Promise<{ success: boolean; data?: { merged: boolean; conflicts?: string[]; alreadyUpToDate?: boolean; uncommittedChanges?: boolean }; error?: string }>
            gitMergeAbort: (workspacePath: string) => Promise<{ success: boolean; error?: string }>
            gitDeleteBranch: (workspacePath: string, branchName: string, force?: boolean) => Promise<{ success: boolean; error?: string }>

            // GitHub CLI
            ghCheckAuth: () => Promise<{ authenticated: boolean; message: string }>
            ghAuthLogin: () => Promise<{ success: boolean; message: string }>
            ghCreatePR: (workspacePath: string, title: string, body: string) => Promise<{ success: boolean; url: string }>
            ghListPRs: (workspacePath: string) => Promise<any[]>
            ghRepoView: (workspacePath: string) => Promise<any>
            ghWorkflowStatus: (workspacePath: string) => Promise<IPCResult<any[]>>
            ghPushBranch: (workspacePath: string, branchName: string) => Promise<IPCResult<void>>
            ghMergePR: (workspacePath: string, prNumber: number) => Promise<{ success: boolean; message: string }>
            ghCreatePRFromWorktree: (workspacePath: string, branchName: string, title: string, body: string) => Promise<IPCResult<{ url: string }>>

            // Editor
            openInEditor: (workspacePath: string, editorType?: string) => Promise<{ success: boolean; editor?: string; error?: string }>
            openFileInEditor: (filePath: string, baseCwd: string, line?: number, column?: number) => Promise<{ success: boolean; error?: string }>

            // Terminal
            createTerminal: (id: string, cwd: string, cols: number, rows: number, shell?: string) => Promise<boolean>
            resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
            killTerminal: (id: string) => Promise<void>
            hasRunningProcess: (id: string) => Promise<boolean>
            getTerminalPreview: (id: string, lineCount?: number) => Promise<string[]>
            writeTerminal: (id: string, data: string) => void
            onTerminalData: (id: string, callback: (data: string) => void) => () => void

            // CLI Session Tracking
            onCliSessionDetected: (callback: (data: { workspaceId: string; sessionId: string; cliSessionId: string; cliToolName: string }) => void) => () => void
            updateSessionCliInfo: (workspaceId: string, sessionId: string, cliSessionId: string, cliToolName: string) => Promise<boolean>
            clearSessionCliInfo: (workspaceId: string, sessionId: string) => Promise<boolean>
            rewriteCliCommand: (command: string) => Promise<{ command: string; cliSessionId: string; cliToolName: string } | null>

            // System Monitor
            getSystemInfo: () => Promise<SystemInfo>

            // Ports
            onPortUpdate: (callback: (ports: { port: number, pid: number, command: string }[]) => void) => () => void
            killProcess: (pid: number) => Promise<boolean>
            refreshPorts: () => Promise<boolean>

            // Terminal Zoom
            onTerminalZoom: (callback: (key: string) => void) => () => void

            // Terminal Clear (Cmd+K)
            clearTerminal: (id: string) => void
            onTerminalClear: (id: string, callback: () => void) => () => void

            // UI Zoom
            zoomUi: (action: 'in' | 'out' | 'reset') => void

            // Shell Validation
            validateShellPath: (shellPath: string) => Promise<{ valid: boolean; resolvedPath?: string; error?: string }>

            // Editor Validation (opens folder picker if testDir not provided)
            validateEditorPath: (editorPath: string, testDir?: string) => Promise<{ valid: boolean; resolvedPath?: string; error?: string }>

            // License
            licenseActivate: (licenseKey: string) => Promise<IPCResult<LicenseData>>
            licenseValidate: () => Promise<IPCResult<LicenseData>>
            licenseDeactivate: () => Promise<IPCResult<void>>
            licenseCheck: () => Promise<IPCResult<{ hasLicense: boolean }>>
            licenseGetInfo: () => Promise<IPCResult<LicenseInfo>>

            // Updates
            checkForUpdate: () => Promise<{ success: boolean; version?: string; hasUpdate?: boolean; error?: string }>
            downloadUpdate: () => Promise<{ success: boolean; error?: string }>
            installUpdate: () => Promise<void>
            onUpdateStatus: (callback: (status: { status: string; version?: string; percent?: number; message?: string }) => void) => () => void
            getAppVersion: () => Promise<string>
            checkTools: () => Promise<{ git: boolean; gh: boolean; brew: boolean }>

            // File utilities (for drag & drop)
            getFilePath: (file: File) => string

            // File Search
            searchFiles: (workspacePath: string, searchQuery: string) => Promise<{ success: boolean; files: Array<{ path: string; relativePath: string; name: string }>; error?: string }>
            searchContent: (workspacePath: string, searchQuery: string) => Promise<{
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
            }>
            readFileContent: (filePath: string, maxSize?: number) => Promise<{
                success: boolean;
                content?: string;
                error?: string;
                size?: number
            }>
            readImageAsBase64: (filePath: string, maxSize?: number) => Promise<{
                success: boolean;
                data?: string;
                mimeType?: string;
                error?: string;
                size?: number
            }>
        }
    }
}

export {}
