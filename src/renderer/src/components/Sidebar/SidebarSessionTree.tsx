import React, { useState } from 'react'
import { Reorder } from 'framer-motion'
import type { TerminalSession, Workspace } from '../../../../shared/types'
import { treeGuidesFor, type SessionForest, type TreeGuide } from '../../utils/relatedSessions'
import { SessionItem, type TreeBranch } from './SessionItem'
import { SidebarSessionList } from './SidebarSessionList'

type SessionListProps = Omit<React.ComponentProps<typeof SidebarSessionList>, 'entries'>

interface SidebarSessionTreeProps {
    forest: SessionForest
    listProps: SessionListProps
}

type Row = { session: TerminalSession; workspace: Workspace; depth: number }
type ShownRow = Row & { branch: TreeBranch | null | undefined; guide?: TreeGuide }

/** Folded rows, by session id. A per-machine view choice like the layout itself, so it outlives a restart. */
const COLLAPSED_STORAGE_KEY = 'sidebar-session-tree-collapsed'

function readCollapsed(): Set<string> {
    try {
        const stored = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) ?? '[]')
        return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : [])
    } catch {
        return new Set()
    }
}

/**
 * The rows left on screen once folded rows hide what is under them. `rows` is the forest's
 * order — each session followed by everything under it, deeper — so a row's subtree is the run of
 * deeper rows after it.
 */
function foldRows(rows: Row[], collapsed: Set<string>, activeSessionId: string | undefined, onToggle: (id: string) => void): ShownRow[] {
    const shown: ShownRow[] = []
    let i = 0
    while (i < rows.length) {
        const row = rows[i]
        let end = i + 1
        while (end < rows.length && rows[end].depth > row.depth) end++
        const hiddenCount = end - i - 1
        const folded = hiddenCount > 0 && collapsed.has(row.session.id)
        shown.push({
            ...row,
            branch: hiddenCount > 0
                ? {
                    collapsed: folded,
                    hiddenCount,
                    holdsActive: folded && rows.slice(i + 1, end).some(below => below.session.id === activeSessionId),
                    onToggle: () => onToggle(row.session.id)
                }
                : null
        })
        i = folded ? end : i + 1
    }
    // The guide lines follow what is on screen: a folded row has nothing shown under it.
    const guides = treeGuidesFor(shown.map(row => row.depth))
    return shown.map((row, index) => ({ ...row, guide: guides[index] }))
}

/**
 * The Tree layout of All sessions: each session under its parent — the session that opened it,
 * first worked in it, or that it was dragged onto — joined to it by file-tree guide lines
 * (a35f1aa1), then the sessions in no tree. A row with
 * sessions under it folds (dca55fd6); a folded row whose part holds the active session is marked
 * instead of unfolding, since the user folded it. Rows are the same SessionItem as the list —
 * click, right-click and drag-to-relate behave alike — labelled with the workspace path, cut at
 * the front so the last folder shows.
 */
export function SidebarSessionTree({ forest, listProps }: SidebarSessionTreeProps) {
    const { activeSessionId, sessionStatuses, hooksSettings } = listProps
    const [collapsed, setCollapsed] = useState<Set<string>>(readCollapsed)

    const toggle = (sessionId: string): void => {
        const next = new Set(collapsed)
        if (next.has(sessionId)) next.delete(sessionId)
        else next.add(sessionId)
        // Closed sessions are dropped here, so the stored list does not grow forever.
        const present = new Set(forest.rows.map(row => row.session.id))
        const kept = [...next].filter(id => present.has(id))
        setCollapsed(new Set(kept))
        try {
            localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(kept))
        } catch { /* storage blocked: the fold just won't survive a restart */ }
    }

    // SessionItem is a Reorder.Item and needs a group; the order is computed, so a drop is ignored.
    const rowGroup = (rows: ShownRow[], testId: string) => (
        <Reorder.Group axis="y" values={rows.map(row => row.session)} onReorder={() => {}} className="space-y-0.5" data-testid={testId}>
            {rows.map(({ workspace, session, depth, branch, guide }) => {
                const statusInfo = sessionStatuses?.get(session.id)
                return (
                    <SessionItem
                        key={session.id}
                        session={session}
                        workspace={workspace}
                        workspaceLabel={workspace.path}
                        workspaceLabelFromEnd
                        treeDepth={depth}
                        treeBranch={branch}
                        treeGuide={guide}
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
                        selection={listProps.selection}
                    />
                )
            })}
        </Reorder.Group>
    )

    return (
        <div data-testid="sidebar-session-tree">
            {forest.rows.length > 0 && rowGroup(foldRows(forest.rows, collapsed, activeSessionId, toggle), 'session-tree-rows')}
            {forest.unlinked.length > 0 && (
                <>
                    <div
                        data-testid="session-tree-unlinked"
                        className={`${forest.rows.length > 0 ? 'mt-2' : ''} mb-0.5 px-2 py-0.5 text-[10px] uppercase tracking-wider text-gray-500`}
                        title="Nothing above or below these: no session opened them or had them dragged onto it, and none is under them."
                    >
                        Not in a tree
                    </div>
                    {/* No fold slot: these never have anything under them, and the name keeps the width. */}
                    {rowGroup(forest.unlinked.map(entry => ({ ...entry, depth: 0, branch: undefined })), 'session-tree-unlinked-rows')}
                </>
            )}
        </div>
    )
}
