import { Reorder } from 'framer-motion'
import { TerminalSession, Workspace, SessionStatus, HooksSettings, SplitTerminalLayout, AgentStatusSource } from '../../../../shared/types'
import type { SessionEntry } from '../../utils/sessionNavigation'
import { SessionItem } from './SessionItem'

interface SidebarSessionListProps {
    entries: SessionEntry[]
    activeSessionId?: string
    sessionStatuses?: Map<string, { status: SessionStatus, isClaudeCode: boolean, source?: AgentStatusSource, awaitingInput?: boolean }>
    hooksSettings?: HooksSettings
    terminalPreview?: { enabled: boolean; lineCount: number }
    renamingSessionId: string | null
    fontSize?: number
    splitLayout?: SplitTerminalLayout | null
    onSelect: (workspace: Workspace, session: TerminalSession) => void
    onRemoveSession: (workspaceId: string, sessionId: string, skipConfirm?: boolean) => void
    onRenameSession: (workspaceId: string, sessionId: string, newName: string) => void
    onSessionContextMenu: (e: React.MouseEvent, workspaceId: string, sessionId: string) => void
    onRenameCancel: () => void
    onDragStartSession?: (sessionId: string) => void
    onDragEndSession?: () => void
}

/**
 * Sessions as one flat list, each row labelled with its workspace. Used by the
 * "All sessions" view and by the search results. The rows are the same
 * SessionItem the workspace tree draws, so status colours, the AI mark, click
 * and right-click behave identically.
 */
export function SidebarSessionList({ entries, activeSessionId, sessionStatuses, hooksSettings, ...rest }: SidebarSessionListProps) {
    return (
        // SessionItem is a Reorder.Item and needs a group around it. Order here is
        // computed (recent first), so a drop is ignored: the handle is hidden anyway.
        <Reorder.Group
            axis="y"
            values={entries.map(entry => entry.session)}
            onReorder={() => {}}
            className="space-y-0.5"
        >
            {entries.map(({ workspace, session }) => {
                const statusInfo = sessionStatuses?.get(session.id)
                return (
                    <SessionItem
                        key={session.id}
                        session={session}
                        workspace={workspace}
                        workspaceLabel={workspace.name}
                        hideDragHandle
                        isActive={activeSessionId === session.id}
                        sessionStatus={statusInfo?.status}
                        awaitingInput={statusInfo?.awaitingInput}
                        isClaudeCodeSession={statusInfo?.isClaudeCode}
                        showStatusInSidebar={hooksSettings?.enabled && hooksSettings?.claudeCode?.showInSidebar}
                        terminalPreview={rest.terminalPreview}
                        isRenaming={rest.renamingSessionId === session.id}
                        fontSize={rest.fontSize}
                        onSelect={rest.onSelect}
                        onRemove={rest.onRemoveSession}
                        onRename={rest.onRenameSession}
                        onContextMenu={rest.onSessionContextMenu}
                        onRenameCancel={rest.onRenameCancel}
                        isInSplit={rest.splitLayout?.sessionIds.includes(session.id)}
                        onDragStartSession={rest.onDragStartSession}
                        onDragEndSession={rest.onDragEndSession}
                    />
                )
            })}
        </Reorder.Group>
    )
}
