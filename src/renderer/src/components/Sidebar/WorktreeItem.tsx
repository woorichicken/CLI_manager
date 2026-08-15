import React from 'react'
import { GitBranch, FolderOpen, Plus, Trash2, ChevronRight, ChevronDown } from 'lucide-react'
import { Reorder } from 'framer-motion'
import { Workspace, TerminalSession, SessionStatus, HooksSettings, AgentStatusSource } from '../../../../shared/types'
import { SessionItem } from './SessionItem'

interface WorktreeItemProps {
    worktree: Workspace
    expanded: boolean
    activeSessionId?: string
    sessionStatuses?: Map<string, { status: SessionStatus, isClaudeCode: boolean, source?: AgentStatusSource, awaitingInput?: boolean }>
    hooksSettings?: HooksSettings
    terminalPreview?: { enabled: boolean; lineCount: number }
    fontSize?: number  // Sidebar font size
    showSessionCount?: boolean  // Show session count next to worktree name
    onToggleExpand: (id: string) => void
    onContextMenu: (e: React.MouseEvent, workspaceId: string) => void
    onSelect: (workspace: Workspace, session: TerminalSession) => void
    onRemoveSession: (workspaceId: string, sessionId: string, skipConfirm?: boolean) => void
    onRemoveWorkspace: (id: string) => void
    onOpenInEditor: (workspacePath: string) => void
    onRenameSession: (workspaceId: string, sessionId: string, newName: string) => void
    renamingSessionId: string | null
    onSessionContextMenu: (e: React.MouseEvent, workspaceId: string, sessionId: string) => void
    onRenameCancel: () => void
    onReorderSessions: (workspaceId: string, sessions: TerminalSession[]) => void
}

/**
 * Worktree 워크스페이스 항목 컴포넌트
 * 메인 워크스페이스 아래에 들여쓰기되어 표시
 */
export function WorktreeItem({
    worktree,
    expanded,
    activeSessionId,
    sessionStatuses,
    hooksSettings,
    terminalPreview,
    fontSize = 14,
    showSessionCount = false,
    onToggleExpand,
    onContextMenu,
    onSelect,
    onRemoveSession,
    onRemoveWorkspace,
    onOpenInEditor,
    onRenameSession,
    renamingSessionId,
    onSessionContextMenu,
    onRenameCancel,
    onReorderSessions
}: WorktreeItemProps) {
    return (
        <div>
            <div
                onClick={() => onToggleExpand(worktree.id)}
                onContextMenu={(e) => onContextMenu(e, worktree.id)}
                className="group flex items-center justify-between py-1.5 px-2 rounded hover:bg-white/5 cursor-pointer transition-colors"
            >
                <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
                    {expanded ? (
                        <ChevronDown size={14} className="text-gray-400 shrink-0" />
                    ) : (
                        <ChevronRight size={14} className="text-gray-400 shrink-0" />
                    )}
                    <GitBranch size={14} className="text-green-400 shrink-0" />
                    <span
                        className="font-medium text-green-100 truncate"
                        style={{ fontSize: `${fontSize}px` }}
                    >
                        {worktree.name}
                    </span>
                    {showSessionCount && (worktree.sessions?.length ?? 0) > 0 && (
                        <span className="text-[10px] text-gray-500 shrink-0">
                            ({worktree.sessions.length})
                        </span>
                    )}
                </div>
                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onOpenInEditor(worktree.path)
                        }}
                        className="p-1 hover:bg-blue-500/20 rounded mr-1"
                        title="Open in editor"
                    >
                        <FolderOpen size={12} className="text-gray-400 hover:text-blue-400" />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onContextMenu(e, worktree.id)
                        }}
                        className="p-1 hover:bg-white/10 rounded mr-1"
                    >
                        <Plus size={12} className="text-gray-400" />
                    </button>
                    <button
                        onClick={(e) => {
                            e.stopPropagation()
                            onRemoveWorkspace(worktree.id)
                        }}
                        className="p-1 hover:bg-red-500/20 rounded"
                        title="Delete worktree"
                    >
                        <Trash2 size={12} className="text-gray-400 hover:text-red-400" />
                    </button>
                </div>
            </div>

            {/* Worktree의 세션들 - 드래그 앤 드롭 지원 */}
            {expanded && worktree.sessions && worktree.sessions.length > 0 && (
                <div className="ml-4 pl-2 border-l border-white/5">
                    <Reorder.Group
                        axis="y"
                        values={worktree.sessions}
                        onReorder={(newOrder) => onReorderSessions(worktree.id, newOrder)}
                        className="space-y-0.5"
                    >
                        {worktree.sessions.map((session: TerminalSession) => {
                            const statusInfo = sessionStatuses?.get(session.id)
                            return (
                                <SessionItem
                                    key={session.id}
                                    session={session}
                                    workspace={worktree}
                                    isActive={activeSessionId === session.id}
                                    sessionStatus={statusInfo?.status}
                                        awaitingInput={statusInfo?.awaitingInput}
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
                                />
                            )
                        })}
                    </Reorder.Group>
                </div>
            )}
        </div>
    )
}
