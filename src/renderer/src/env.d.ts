/// <reference types="vite/client" />

import { ElectronAPI } from '@electron-toolkit/preload'
import { Workspace, TerminalSession, UserSettings, IPCResult, PortInfo, UsageSnapshot, AgentStatusUpdate, HookInstallState, HookIntegrationSettings, UsageAlertSettings, DiffBase, DiffSummary, FileDiff, SessionStatus, AgentStatusSource } from '../../shared/types'

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
            createPlayground: () => Promise<Workspace | null>

            // Settings
            getSettings: () => Promise<UserSettings>
            saveSettings: (settings: UserSettings) => Promise<boolean>
            checkGitConfig: () => Promise<{ username: string; email: string } | null>
            checkTools: () => Promise<{ git: boolean; gh: boolean; brew: boolean }>
            getAppVersion: () => Promise<string>

            // Dialog
            selectDirectory: () => Promise<string | null>
            revealInFinder: (filePath: string, baseCwd?: string) => Promise<boolean>
            showMessageBox: (options: { type: 'info' | 'warning' | 'error' | 'question'; title: string; message: string; buttons: string[]; icon?: string }) => Promise<{ response: number }>

            // Templates
            getTemplates: () => Promise<any[]>
            saveTemplates: (templates: any[]) => Promise<boolean>

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
            gitListBranches: (workspacePath: string) => Promise<{ current: string; all: string[]; branches: any } | null>
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

            // Terminal
            createTerminal: (id: string, cwd: string, cols: number, rows: number, shell?: string) => Promise<boolean>
            resizeTerminal: (id: string, cols: number, rows: number) => Promise<void>
            killTerminal: (id: string) => Promise<void>
            hasRunningProcess: (id: string) => Promise<boolean>
            writeTerminal: (id: string, data: string) => void
            onTerminalData: (id: string, callback: (data: string) => void) => () => void

            // Ports
            onPortUpdate: (callback: (ports: PortInfo[]) => void) => () => void
            killProcess: (pid: number) => Promise<boolean>
            refreshPorts: () => Promise<boolean>

            // Terminal Zoom
            onTerminalZoom: (callback: (key: string) => void) => () => void

            // UI Zoom
            zoomUi: (action: 'in' | 'out' | 'reset') => void

            // Shell Validation
            validateShellPath: (shellPath: string) => Promise<{ valid: boolean; resolvedPath?: string; error?: string }>

            // Editor Validation (opens folder picker if testDir not provided)
            validateEditorPath: (editorPath: string, testDir?: string) => Promise<{ valid: boolean; resolvedPath?: string; error?: string }>

            // Updates
            checkForUpdate: () => Promise<{ success: boolean; version?: string; hasUpdate?: boolean; error?: string }>
            downloadUpdate: () => Promise<{ success: boolean; error?: string }>
            installUpdate: () => Promise<void>
            onUpdateStatus: (callback: (status: { status: string; version?: string; percent?: number; message?: string }) => void) => () => void

            // Agent hook integration
            getHookState: () => Promise<HookInstallState>
            setHookIntegration: (settings: HookIntegrationSettings) => Promise<IPCResult<HookInstallState>>
            getAgentStatusSnapshot: () => Promise<AgentStatusUpdate[]>
            reportObservedStatus: (terminalId: string, status: SessionStatus, source: AgentStatusSource) => void
            onAgentStatusUpdate: (callback: (update: AgentStatusUpdate) => void) => () => void

            // Usage
            getUsageSnapshot: () => Promise<UsageSnapshot>
            setUsageAlerts: (settings: UsageAlertSettings) => Promise<boolean>
            onUsageUpdate: (callback: (snapshot: UsageSnapshot) => void) => () => void

            // Diff review
            getDiffSummary: (workspaceId: string, base: DiffBase) => Promise<IPCResult<DiffSummary>>
            getFileDiff: (workspaceId: string, filePath: string, base: DiffBase) => Promise<IPCResult<FileDiff>>
            sendTextToTerminal: (terminalId: string, text: string) => Promise<IPCResult<null>>
        }
    }
}
