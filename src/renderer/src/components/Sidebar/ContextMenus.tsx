import React from 'react'
import { createPortal } from 'react-dom'
import { Terminal, GitBranch, Settings as SettingsIcon, Edit2, Trash2, GitMerge, Download, HardDrive, Copy, RefreshCw, FolderOpen, SquareX, Eraser, Pin } from 'lucide-react'
import { Workspace, TerminalTemplate, TerminalSession } from '../../../../shared/types'
import { getTemplateIcon } from '../../constants/icons'
import { MENU_Z_INDEX } from '../../constants/styles'

interface WorkspaceContextMenuProps {
    x: number
    y: number
    workspacePath: string
    sessions: TerminalSession[]
    templates: TerminalTemplate[]
    isPinned?: boolean
    onTogglePin: () => void
    onAddSession: (type: 'regular' | 'worktree', template?: TerminalTemplate) => void
    onTerminateAll: () => void
    onReloadWorktrees: () => void | Promise<void>
    onOpenSettings: () => void
    onClose: () => void
}

/**
 * 워크스페이스 우클릭 컨텍스트 메뉴
 * 일반 터미널, 커스텀 템플릿, Worktree 생성 옵션 제공
 */
export function WorkspaceContextMenu({
    x,
    y,
    workspacePath,
    sessions,
    templates,
    isPinned,
    onTogglePin,
    onAddSession,
    onTerminateAll,
    onReloadWorktrees,
    onOpenSettings,
    onClose
}: WorkspaceContextMenuProps) {
    const handleCopyPath = async () => {
        try {
            await navigator.clipboard.writeText(workspacePath)
        } catch (err) {
            console.error('Failed to copy path:', err)
        }
        onClose()
    }

    const handleRevealInFinder = async () => {
        try {
            await window.api.revealInFinder(workspacePath)
        } catch (err) {
            console.error('Failed to reveal in finder:', err)
        }
        onClose()
    }

    const handleReloadWorktrees = async () => {
        try {
            await onReloadWorktrees()
        } catch (err) {
            console.error('Failed to reload worktrees:', err)
        }
        onClose()
    }

    return createPortal(
        <div
            className={`fixed z-[${MENU_Z_INDEX}] bg-[#1e1e20] border border-white/10 rounded shadow-xl py-0.5 w-44 backdrop-blur-md`}
            style={{ top: y, left: x }}
            onClick={e => e.stopPropagation()}
        >
            {/* Pin / Unpin */}
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                onClick={() => {
                    onTogglePin()
                    onClose()
                }}
            >
                <Pin size={12} className={isPinned ? "text-blue-400 shrink-0" : "text-gray-400 shrink-0"} />
                <span className="truncate">{isPinned ? 'Unpin' : 'Pin to Top'}</span>
            </button>

            {/* Copy Path */}
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                onClick={handleCopyPath}
                title={workspacePath}
            >
                <Copy size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Copy Path</span>
            </button>

            {/* Reveal in Finder */}
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                onClick={handleRevealInFinder}
                title="Open in Finder"
            >
                <FolderOpen size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Reveal in Finder</span>
            </button>

            {/* Reload Worktrees */}
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                onClick={handleReloadWorktrees}
                title="Sync worktree workspaces from git"
            >
                <RefreshCw size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Reload Worktrees</span>
            </button>

            {/* Terminate All Terminals */}
            {sessions.length > 0 && (
                <button
                    className="w-full text-left px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/20 hover:text-red-200 transition-colors flex items-center gap-2"
                    onClick={() => {
                        onTerminateAll()
                        onClose()
                    }}
                    title={`Terminate all ${sessions.length} terminal(s)`}
                >
                    <SquareX size={12} className="text-red-400 shrink-0" />
                    <span className="truncate">Terminate All ({sessions.length})</span>
                </button>
            )}

            <div className="border-t border-white/10 my-0.5"></div>

            <div className="px-2.5 py-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                New Terminal
            </div>

            {/* Plain Terminal */}
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                onClick={() => {
                    onAddSession('regular', {
                        id: 'plain',
                        name: 'Plain Terminal',
                        icon: 'terminal',
                        description: 'Basic terminal',
                        command: ''
                    })
                    onClose()
                }}
                title="Basic terminal"
            >
                <Terminal size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Plain Terminal</span>
            </button>

            {/* Custom Templates */}
            {templates.map(template => (
                <button
                    key={template.id}
                    className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                    onClick={() => {
                        onAddSession('regular', template)
                        onClose()
                    }}
                    title={template.description || template.command}
                >
                    <span className="text-gray-400 shrink-0">
                        {getTemplateIcon(template.icon)}
                    </span>
                    <span className="truncate">{template.name}</span>
                </button>
            ))}

            <div className="border-t border-white/10 my-0.5"></div>

            {/* Worktree */}
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                onClick={() => {
                    onAddSession('worktree')
                    onClose()
                }}
                title="Create git worktree"
            >
                <GitBranch size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">New Worktree</span>
            </button>

            <div className="border-t border-white/10 my-0.5"></div>

            {/* Manage Templates */}
            <button
                className="w-full text-left px-2.5 py-1 text-[10px] text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1.5"
                onClick={() => {
                    onClose()
                    onOpenSettings()
                }}
            >
                <SettingsIcon size={10} />
                <span>Manage Templates...</span>
            </button>
        </div>,
        document.body
    )
}

interface WorktreeContextMenuProps {
    x: number
    y: number
    workspace: Workspace
    templates: TerminalTemplate[]
    parentWorkspacePath?: string  // 부모 워크스페이스 경로 (merge용)
    onMergeToMain: () => void  // 현재 브랜치를 main으로 머지
    onPullFromMain: () => void  // main에서 현재 브랜치로 머지
    onReloadWorktrees: () => void | Promise<void>
    onAddSession: (workspaceId: string, template?: TerminalTemplate) => void
    onClose: () => void
}

/**
 * Worktree 우클릭 컨텍스트 메뉴
 * 로컬 Git 작업, 터미널 추가 기능 제공
 */
export function WorktreeContextMenu({
    x,
    y,
    workspace,
    templates,
    onMergeToMain,
    onPullFromMain,
    onReloadWorktrees,
    onAddSession,
    onClose
}: WorktreeContextMenuProps) {
    const handleCopyPath = async (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        try {
            await navigator.clipboard.writeText(workspace.path)
        } catch (err) {
            console.error('Failed to copy path:', err)
        }
        onClose()
    }

    const handleRevealInFinder = async (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        try {
            await window.api.revealInFinder(workspace.path)
        } catch (err) {
            console.error('Failed to reveal in finder:', err)
        }
        onClose()
    }

    const handleMergeToMainClick = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        onMergeToMain()
        onClose()
    }

    const handlePullFromMainClick = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        onPullFromMain()
        onClose()
    }

    const handleTerminalClick = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        onAddSession(workspace.id)
        onClose()
    }

    const handleReloadWorktrees = async (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        try {
            await onReloadWorktrees()
        } catch (err) {
            console.error('Failed to reload worktrees:', err)
        }
        onClose()
    }

    const handleTemplateClick = (e: React.MouseEvent, template: TerminalTemplate) => {
        e.preventDefault()
        e.stopPropagation()
        onAddSession(workspace.id, template)
        onClose()
    }

    return createPortal(
        <div
            className="fixed bg-[#1e1e20] border border-white/10 rounded shadow-xl py-1 w-48 backdrop-blur-md max-h-[400px] overflow-y-auto"
            style={{
                top: y,
                left: x,
                zIndex: MENU_Z_INDEX
            }}
            onClick={e => e.stopPropagation()}
        >
            {/* Copy Path */}
            <button
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all duration-150 flex items-center gap-2 cursor-pointer"
                onClick={handleCopyPath}
                onMouseDown={(e) => e.stopPropagation()}
                title={workspace.path}
                type="button"
            >
                <Copy size={13} className="text-gray-400 shrink-0" />
                <span className="truncate">Copy Path</span>
            </button>

            {/* Reveal in Finder */}
            <button
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all duration-150 flex items-center gap-2 cursor-pointer"
                onClick={handleRevealInFinder}
                onMouseDown={(e) => e.stopPropagation()}
                title="Open in Finder"
                type="button"
            >
                <FolderOpen size={13} className="text-gray-400 shrink-0" />
                <span className="truncate">Reveal in Finder</span>
            </button>

            <button
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all duration-150 flex items-center gap-2 cursor-pointer"
                onClick={handleReloadWorktrees}
                onMouseDown={(e) => e.stopPropagation()}
                title="Sync worktree workspaces from git"
                type="button"
            >
                <RefreshCw size={13} className="text-gray-400 shrink-0" />
                <span className="truncate">Reload Worktrees</span>
            </button>

            <div className="border-t border-white/10 my-1"></div>

            {/* Local Git Section - 로컬 작업 */}
            <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center gap-1.5">
                <HardDrive size={10} />
                Local Git
            </div>

            <button
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all duration-150 flex items-center gap-2 cursor-pointer"
                onClick={handleMergeToMainClick}
                onMouseDown={(e) => e.stopPropagation()}
                title="Merge this branch into main/master"
                type="button"
            >
                <GitMerge size={13} className="text-purple-400 shrink-0" />
                <span className="truncate">Merge to main</span>
            </button>

            <button
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all duration-150 flex items-center gap-2 cursor-pointer"
                onClick={handlePullFromMainClick}
                onMouseDown={(e) => e.stopPropagation()}
                title="Merge main/master into this branch"
                type="button"
            >
                <Download size={13} className="text-cyan-400 shrink-0" />
                <span className="truncate">Pull from main</span>
            </button>

            <div className="border-t border-white/10 my-1"></div>

            {/* Terminal Section */}
            <div className="px-3 py-1.5 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                New Terminal
            </div>

            {/* Plain Terminal */}
            <button
                className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all duration-150 flex items-center gap-2 cursor-pointer"
                onClick={handleTerminalClick}
                onMouseDown={(e) => e.stopPropagation()}
                title="Basic terminal"
                type="button"
            >
                <Terminal size={13} className="text-gray-400 shrink-0" />
                <span className="truncate">Plain Terminal</span>
            </button>

            {/* Custom Templates */}
            {templates.map(template => (
                <button
                    key={template.id}
                    className="w-full text-left px-3 py-2 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-all duration-150 flex items-center gap-2 cursor-pointer"
                    onClick={(e) => handleTemplateClick(e, template)}
                    onMouseDown={(e) => e.stopPropagation()}
                    title={template.description || template.command}
                    type="button"
                >
                    <span className="text-gray-400 shrink-0">
                        {getTemplateIcon(template.icon)}
                    </span>
                    <span className="truncate">{template.name}</span>
                </button>
            ))}
        </div>,
        document.body
    )
}

interface BranchMenuProps {
    x: number
    y: number
    branches: string[]
    currentBranch: string
    worktreeBranches?: string[]  // Branches checked out in worktrees (disabled)
    loading?: boolean  // Loading state for refresh
    onCheckout: (branchName: string) => void
    onRefresh: () => void  // Refresh branch list
    onClose: () => void
}

/**
 * 브랜치 선택 메뉴
 * Git 브랜치 전환 기능 제공
 * Worktree로 체크아웃된 브랜치는 비활성화 + "(worktree)" 표시
 */
export function BranchMenu({
    x,
    y,
    branches,
    currentBranch,
    worktreeBranches = [],
    loading = false,
    onCheckout,
    onRefresh,
    onClose
}: BranchMenuProps) {
    const handleRefresh = (e: React.MouseEvent) => {
        e.stopPropagation()
        onRefresh()
    }

    return createPortal(
        <div
            className={`fixed z-[${MENU_Z_INDEX}] bg-[#1e1e20] border border-white/10 rounded shadow-xl py-0.5 w-52 backdrop-blur-md max-h-64 overflow-y-auto`}
            style={{ top: y, left: x }}
            onClick={e => e.stopPropagation()}
        >
            <div className="px-2.5 py-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider flex items-center justify-between">
                <span>Switch Branch</span>
                <button
                    onClick={handleRefresh}
                    disabled={loading}
                    className="p-0.5 hover:bg-white/10 rounded transition-colors disabled:opacity-50"
                    title="Refresh branches"
                >
                    <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
                </button>
            </div>

            {branches.map(branch => {
                const isCurrentBranch = branch === currentBranch
                // Check if this branch is used in a worktree (excluding current branch)
                const isWorktreeBranch = !isCurrentBranch && worktreeBranches.includes(branch)
                const isDisabled = isCurrentBranch || isWorktreeBranch

                return (
                    <button
                        key={branch}
                        className={`w-full text-left px-2.5 py-1.5 text-xs transition-colors flex items-center gap-2 ${isCurrentBranch
                            ? "bg-blue-500/20 text-blue-300 font-medium"
                            : isWorktreeBranch
                                ? "text-gray-500 cursor-not-allowed"
                                : "text-gray-300 hover:bg-white/10 hover:text-white"
                            }`}
                        onClick={() => {
                            if (!isDisabled) {
                                onCheckout(branch)
                            }
                            onClose()
                        }}
                        disabled={isDisabled}
                    >
                        <GitBranch size={12} className={isCurrentBranch ? "text-blue-400" : isWorktreeBranch ? "text-gray-600" : "text-gray-400"} />
                        <span className="truncate">{branch}</span>
                        {isCurrentBranch && <span className="ml-auto text-[9px] text-blue-400">✓</span>}
                        {isWorktreeBranch && <span className="ml-auto text-[9px] text-amber-500/70">(worktree)</span>}
                    </button>
                )
            })}
        </div>,
        document.body
    )
}

interface SessionContextMenuProps {
    x: number
    y: number
    sessionId: string
    onRename: () => void
    onDelete: () => void
    onClear: () => void
    onClose: () => void
}

/**
 * 세션 우클릭 컨텍스트 메뉴
 * 이름 변경, 삭제, 터미널 클리어 기능 제공
 */
export function SessionContextMenu({
    x,
    y,
    sessionId,
    onRename,
    onDelete,
    onClear,
    onClose
}: SessionContextMenuProps) {
    return createPortal(
        <div
            className={`fixed z-[${MENU_Z_INDEX}] bg-[#1e1e20] border border-white/10 rounded shadow-xl py-0.5 w-36 backdrop-blur-md`}
            style={{ top: y, left: x }}
            onClick={e => e.stopPropagation()}
        >
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                onClick={() => {
                    onClear()
                    onClose()
                }}
                title="Clear scrollback buffer (⌘K)"
            >
                <Eraser size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Clear Terminal</span>
            </button>
            <div className="border-t border-white/10 my-0.5"></div>
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2"
                onClick={() => {
                    onRename()
                    onClose()
                }}
            >
                <Edit2 size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Rename</span>
            </button>
            <button
                className="w-full text-left px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/20 hover:text-red-200 transition-colors flex items-center gap-2"
                onClick={() => {
                    onDelete()
                    onClose()
                }}
            >
                <Trash2 size={12} className="text-red-400 shrink-0" />
                <span className="truncate">Delete</span>
            </button>
        </div>,
        document.body
    )
}
