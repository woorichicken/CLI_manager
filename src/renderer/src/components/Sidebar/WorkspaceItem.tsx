import React from 'react'
import { Folder, FolderOpen, Plus, Trash2, ChevronRight, ChevronDown, GitBranch, Home, Pin } from 'lucide-react'
import clsx from 'clsx'
import { Reorder } from 'framer-motion'
import { Workspace, TerminalSession, SessionStatus, HooksSettings, SplitTerminalLayout } from '../../../../shared/types'
import { SessionItem } from './SessionItem'
import { WorktreeItem } from './WorktreeItem'

interface WorkspaceItemProps {
    workspace: Workspace
    childWorktrees: Workspace[]
    expanded: boolean
    expandedSet: Set<string>  // 전체 expanded 상태를 관리하는 Set 추가
    branchInfo?: { current: string; all: string[] }
    activeSessionId?: string
    sessionStatuses?: Map<string, { status: SessionStatus, isClaudeCode: boolean }>
    hooksSettings?: HooksSettings
    terminalPreview?: { enabled: boolean; lineCount: number }
    fontSize?: number  // Sidebar font size
    showSessionCount?: boolean  // Show session count next to workspace name
    isPinned?: boolean
    onToggleExpand: (id: string) => void
    onContextMenu: (e: React.MouseEvent, workspaceId: string) => void
    onBranchClick: (e: React.MouseEvent, workspace: Workspace) => void
    onSelect: (workspace: Workspace, session: TerminalSession) => void
    onRemoveSession: (workspaceId: string, sessionId: string, skipConfirm?: boolean) => void
    onRemoveWorkspace: (id: string) => void
    onOpenInEditor: (workspacePath: string) => void
    onRenameSession: (workspaceId: string, sessionId: string, newName: string) => void
    renamingSessionId: string | null
    onSessionContextMenu: (e: React.MouseEvent, workspaceId: string, sessionId: string) => void
    onRenameCancel: () => void
    onReorderSessions: (workspaceId: string, sessions: TerminalSession[]) => void
    // Split view props
    splitLayout?: SplitTerminalLayout | null
    onDragStartSession?: (sessionId: string) => void
    onDragEndSession?: () => void
}

/**
 * 워크스페이스 항목 컴포넌트
 * 세션 목록과 자식 워크트리들을 포함
 */
export function WorkspaceItem({
    workspace,
    childWorktrees,
    expanded,
    expandedSet,
    branchInfo,
    activeSessionId,
    sessionStatuses,
    hooksSettings,
    terminalPreview,
    fontSize = 14,
    showSessionCount = false,
    isPinned = false,
    onToggleExpand,
    onContextMenu,
    onBranchClick,
    onSelect,
    onRemoveSession,
    onRemoveWorkspace,
    onOpenInEditor,
    onRenameSession,
    renamingSessionId,
    onSessionContextMenu,
    onRenameCancel,
    onReorderSessions,
    splitLayout,
    onDragStartSession,
    onDragEndSession
}: WorkspaceItemProps) {
    return (
        <div>
            <div
                onClick={() => onToggleExpand(workspace.id)}
                onContextMenu={(e) => onContextMenu(e, workspace.id)}
                className="group relative flex items-center justify-between py-1.5 px-2 rounded hover:bg-white/5 cursor-pointer transition-colors"
            >
                <div className="flex flex-col gap-0.5 overflow-hidden flex-1 min-w-0">
                    <div className="flex items-center gap-2 overflow-hidden">
                        {expanded ? (
                            <ChevronDown size={14} className="text-gray-400 shrink-0" />
                        ) : (
                            <ChevronRight size={14} className="text-gray-400 shrink-0" />
                        )}
                        {workspace.isHome ? (
                            <Home size={16} className="text-emerald-400 shrink-0" />
                        ) : workspace.isPlayground ? (
                            <Folder size={16} className="text-yellow-400 shrink-0" />
                        ) : (
                            <Folder size={16} className="text-blue-400 shrink-0" />
                        )}
                        <span
                            className={clsx(
                                "font-medium truncate",
                                workspace.isHome ? "text-emerald-100" :
                                workspace.isPlayground ? "text-yellow-100" : ""
                            )}
                            style={{ fontSize: `${fontSize}px` }}
                        >
                            {workspace.name}
                        </span>
                        {isPinned && (
                            <Pin size={10} className="text-blue-400/60 shrink-0" />
                        )}
                        {showSessionCount && (() => {
                            const totalSessions = (workspace.sessions?.length ?? 0)
                                + childWorktrees.reduce((sum, wt) => sum + (wt.sessions?.length ?? 0), 0)
                            return totalSessions > 0 ? (
                                <span className="text-[10px] text-gray-500 shrink-0">
                                    ({totalSessions})
                                </span>
                            ) : null
                        })()}
                    </div>
                    {branchInfo && (
                        <div
                            className="ml-7 flex items-center gap-1 text-[10px] text-gray-500 hover:text-blue-400 transition-colors cursor-pointer"
                            onClick={(e) => onBranchClick(e, workspace)}
                        >
                            <GitBranch size={10} />
                            <span className="truncate">{branchInfo.current}</span>
                        </div>
                    )}
                </div>
                <div className={clsx(
                    "absolute right-2 flex items-center opacity-0 group-hover:opacity-100 transition-opacity bg-[#0f0f12]",
                    // Home workspace has fewer buttons, so smaller shadow
                    workspace.isHome ? "shadow-[-4px_0_6px_#0f0f12]" : "shadow-[-10px_0_10px_#0f0f12]"
                )}>
                    {/* Hide "Open in editor" for home workspace */}
                    {!workspace.isHome && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onOpenInEditor(workspace.path)
                            }}
                            className="p-1 hover:bg-blue-500/20 rounded mr-1"
                            title="Open in editor"
                        >
                            <FolderOpen size={12} className="text-gray-400 hover:text-blue-400" />
                        </button>
                    )}
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onContextMenu(e, workspace.id)
                        }}
                        className={clsx("p-1 hover:bg-white/10 rounded", !workspace.isHome && "mr-1")}
                    >
                        <Plus size={12} className="text-gray-400" />
                    </button>
                    {/* Hide delete button for home workspace */}
                    {!workspace.isHome && (
                        <button
                            onClick={(e) => {
                                e.stopPropagation()
                                onRemoveWorkspace(workspace.id)
                            }}
                            className="p-1 hover:bg-red-500/20 rounded"
                        >
                            <Trash2 size={12} className="text-gray-400 hover:text-red-400" />
                        </button>
                    )}
                </div>
            </div>

            {expanded && (
                <div className="ml-4 pl-2 border-l border-white/5 space-y-0.5">
                    {/* 부모 workspace의 세션들 - 드래그 앤 드롭 지원 */}
                    {workspace.sessions && workspace.sessions.length > 0 && (
                        <Reorder.Group
                            axis="y"
                            values={workspace.sessions}
                            onReorder={(newOrder) => onReorderSessions(workspace.id, newOrder)}
                            className="space-y-0.5"
                        >
                            {workspace.sessions.map((session: TerminalSession) => {
                                const statusInfo = sessionStatuses?.get(session.id)
                                return (
                                    <SessionItem
                                        key={session.id}
                                        session={session}
                                        workspace={workspace}
                                        isActive={activeSessionId === session.id}
                                        sessionStatus={statusInfo?.status}
                                        isClaudeCodeSession={statusInfo?.isClaudeCode}
                                        showStatusInSidebar={hooksSettings?.enabled && hooksSettings?.claudeCode?.showInSidebar}
                                        terminalPreview={terminalPreview}
                                        isRenaming={renamingSessionId === session.id}
                                        fontSize={fontSize}
                                        onSelect={onSelect}
                                        onRemove={onRemoveSession}
                                        onRename={onRenameSession}
                                        onContextMenu={onSessionContextMenu}
                                        onRenameCancel={onRenameCancel}
                                        isInSplit={splitLayout?.sessionIds.includes(session.id)}
                                        onDragStartSession={onDragStartSession}
                                        onDragEndSession={onDragEndSession}
                                    />
                                )
                            })}
                        </Reorder.Group>
                    )}

                    {/* 자식 worktree workspace들 */}
                    {childWorktrees.map(worktree => (
                        <WorktreeItem
                            key={worktree.id}
                            worktree={worktree}
                            expanded={expandedSet.has(worktree.id)}
                            activeSessionId={activeSessionId}
                            sessionStatuses={sessionStatuses}
                            hooksSettings={hooksSettings}
                            terminalPreview={terminalPreview}
                            fontSize={fontSize}
                            showSessionCount={showSessionCount}
                            onToggleExpand={onToggleExpand}
                            onContextMenu={onContextMenu}
                            onSelect={onSelect}
                            onRemoveSession={onRemoveSession}
                            onRemoveWorkspace={onRemoveWorkspace}
                            onOpenInEditor={onOpenInEditor}
                            onRenameSession={onRenameSession}
                            renamingSessionId={renamingSessionId}
                            onSessionContextMenu={onSessionContextMenu}
                            onRenameCancel={onRenameCancel}
                            onReorderSessions={onReorderSessions}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
