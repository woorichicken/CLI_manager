import { useCallback, useState } from 'react'
import type { ChatThreadEntry } from '../../../../shared/conversation'
import type { TerminalSession, Workspace } from '../../../../shared/types'
import { useAllChatThreads } from '../../hooks/useAllChatThreads'
import { setOpenThread } from '../ChatView/threadSelection'
import { switchSessionView } from '../../utils/sessionViewSwitch'

// A per-machine view choice, like the List / Tree layout beside it.
const THREADS_OPEN_STORAGE_KEY = 'sidebar-threads-open'

function readSavedThreadsOpen(): boolean {
    try {
        return localStorage.getItem(THREADS_OPEN_STORAGE_KEY) === 'true'
    } catch {
        return false
    }
}

/**
 * The All sessions Threads list: whether it is on, its rows, and what opening one does — the
 * parent session in Chat with that thread's panel beside it. The sidebar stays on Threads.
 */
export function useThreadsView({ inAllSessions, workspaces, onSelect }: {
    inAllSessions: boolean
    workspaces: Workspace[]
    onSelect: (workspace: Workspace, session: TerminalSession) => void
}) {
    const [threadsOpen, setThreadsOpenState] = useState(readSavedThreadsOpen)
    const [selectedChildId, setSelectedChildId] = useState<string | null>(null)
    const threads = useAllChatThreads(!inAllSessions ? 'off' : threadsOpen ? 'open' : 'closed')
    const waitingThreads = threads.filter((thread) => thread.status === 'waiting').length

    const setThreadsOpen = useCallback((next: boolean) => {
        setThreadsOpenState(next)
        try {
            localStorage.setItem(THREADS_OPEN_STORAGE_KEY, next ? 'true' : 'false')
        } catch { /* storage blocked: the choice just won't survive a restart */ }
    }, [])

    const find = useCallback((sessionId: string) => {
        const workspace = workspaces.find((candidate) => candidate.sessions?.some((session) => session.id === sessionId))
        const session = workspace?.sessions.find((candidate) => candidate.id === sessionId)
        return workspace && session ? { workspace, session } : null
    }, [workspaces])

    /** A row: the thread as a session of its own, in Chat (8a858cc3 — «open as session by default»). */
    const openThreadRow = useCallback((thread: ChatThreadEntry) => {
        const child = find(thread.childId)
        if (!child) return
        switchSessionView(thread.childId, 'chat')
        setSelectedChildId(thread.childId)
        onSelect(child.workspace, child.session)
    }, [find, onSelect])

    /** The row's small split icon: the parent's Chat with that thread's panel beside it. */
    const openThreadBeside = useCallback((thread: ChatThreadEntry) => {
        const parent = find(thread.parentId)
        if (!parent) return
        // The panel choice first: a parent Chat view mounting now reads it, one on screen follows it.
        setOpenThread(thread.parentId, thread.childId)
        switchSessionView(thread.parentId, 'chat')
        setSelectedChildId(thread.childId)
        onSelect(parent.workspace, parent.session)
    }, [find, onSelect])

    return { threadsOpen: inAllSessions && threadsOpen, setThreadsOpen, threads, waitingThreads, selectedChildId, openThreadRow, openThreadBeside }
}
