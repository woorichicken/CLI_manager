import React from 'react'
import { Reorder } from 'framer-motion'
import type { TerminalSession, Workspace } from '../../../../shared/types'
import type { SessionForest } from '../../utils/relatedSessions'
import { SessionItem } from './SessionItem'
import { SidebarSessionList } from './SidebarSessionList'

type SessionListProps = Omit<React.ComponentProps<typeof SidebarSessionList>, 'entries'>

interface SidebarSessionTreeProps {
    forest: SessionForest
    listProps: SessionListProps
}

type Row = { session: TerminalSession; workspace: Workspace; depth: number }

/**
 * The Tree layout of All sessions: each session under the session that opened
 * it (or first worked in it), then the sessions in no tree. Rows are the same
 * SessionItem as the list — click, right-click and drag-to-relate behave alike —
 * labelled with the workspace path, cut at the front so the last folder shows.
 */
export function SidebarSessionTree({ forest, listProps }: SidebarSessionTreeProps) {
    const { activeSessionId, sessionStatuses, hooksSettings } = listProps

    // SessionItem is a Reorder.Item and needs a group; the order is computed, so a drop is ignored.
    const rowGroup = (rows: Row[], testId: string) => (
        <Reorder.Group axis="y" values={rows.map(row => row.session)} onReorder={() => {}} className="space-y-0.5" data-testid={testId}>
            {rows.map(({ workspace, session, depth }) => {
                const statusInfo = sessionStatuses?.get(session.id)
                return (
                    <SessionItem
                        key={session.id}
                        session={session}
                        workspace={workspace}
                        workspaceLabel={workspace.path}
                        workspaceLabelFromEnd
                        treeDepth={depth}
                        hideDragHandle
                        isActive={activeSessionId === session.id}
                        sessionStatus={statusInfo?.status}
                        awaitingInput={statusInfo?.awaitingInput}
                        isClaudeCodeSession={statusInfo?.isClaudeCode}
                        showStatusInSidebar={hooksSettings?.enabled && hooksSettings?.claudeCode?.showInSidebar}
                        terminalPreview={listProps.terminalPreview}
                        isRenaming={listProps.renamingSessionId === session.id}
                        fontSize={listProps.fontSize}
                        onSelect={listProps.onSelect}
                        onRemove={listProps.onRemoveSession}
                        onRename={listProps.onRenameSession}
                        onContextMenu={listProps.onSessionContextMenu}
                        onRenameCancel={listProps.onRenameCancel}
                        isInSplit={listProps.splitLayout?.sessionIds.includes(session.id)}
                        onDragStartSession={listProps.onDragStartSession}
                        onDragEndSession={listProps.onDragEndSession}
                    />
                )
            })}
        </Reorder.Group>
    )

    return (
        <div data-testid="sidebar-session-tree">
            {forest.rows.length > 0 && rowGroup(forest.rows, 'session-tree-rows')}
            {forest.unlinked.length > 0 && (
                <>
                    <div
                        data-testid="session-tree-unlinked"
                        className={`${forest.rows.length > 0 ? 'mt-2' : ''} mb-0.5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-gray-500`}
                        title="No session opened these, and they opened none. Pairs added by hand have no direction, so they stay here."
                    >
                        Not in a tree
                    </div>
                    {rowGroup(forest.unlinked.map(entry => ({ ...entry, depth: 0 })), 'session-tree-unlinked-rows')}
                </>
            )}
        </div>
    )
}
