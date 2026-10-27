import { Dispatch, SetStateAction, useCallback, useEffect, useRef, useState } from 'react'
import { SessionFolder, Workspace } from '../../../shared/types'

export interface SessionFolderActions {
    create: (name: string) => Promise<void>
    rename: (folderId: string, name: string) => Promise<void>
    remove: (folderId: string) => Promise<void>
    toggleExpanded: (folderId: string) => Promise<void>
    setExpanded: (folderIds: string[], expanded: boolean) => Promise<void>
    /** `null` takes the session out of its folder. */
    moveSession: (sessionId: string, folderId: string | null) => Promise<void>
}

/** Every session's folder field set by `change`, touching only the workspaces that hold a changed session. */
function withSessionFolders(
    workspaces: Workspace[],
    change: (current: string | undefined, sessionId: string) => string | undefined
): Workspace[] {
    return workspaces.map(workspace => {
        let changed = false
        const sessions = workspace.sessions.map(session => {
            const next = change(session.sessionFolderId, session.id)
            if (next === session.sessionFolderId) return session
            changed = true
            return { ...session, sessionFolderId: next }
        })
        return changed ? { ...workspace, sessions } : workspace
    })
}

/**
 * Session folders of the sidebar's All sessions view (report 078ee766). The
 * folder list is held here; a session's membership lives on the session in
 * `workspaces`, so moves and deletes update that state too. Changes show at once
 * and are written to the store behind them.
 */
export function useSessionFolders(setWorkspaces: Dispatch<SetStateAction<Workspace[]>>) {
    const [sessionFolders, setSessionFolders] = useState<SessionFolder[]>([])
    // Two quick clicks on a heading come before a re-render: read the latest list, not the render's.
    const foldersRef = useRef(sessionFolders)
    foldersRef.current = sessionFolders

    useEffect(() => {
        window.api.getSessionFolders().then(setSessionFolders).catch(() => {})
    }, [])

    // The Control API changes the list from main; the window's own changes are not echoed back.
    useEffect(() => window.api.onSessionFolders(setSessionFolders), [])

    const create = useCallback(async (name: string) => {
        const folder = await window.api.createSessionFolder(name)
        // The Control API's broadcast can carry this folder before the reply does: add it once.
        if (folder) setSessionFolders(prev => prev.some(f => f.id === folder.id) ? prev : [...prev, folder])
    }, [])

    const rename = useCallback(async (folderId: string, name: string) => {
        const trimmed = name.trim()
        if (!trimmed) return
        setSessionFolders(prev => prev.map(f => f.id === folderId ? { ...f, name: trimmed } : f))
        await window.api.renameSessionFolder(folderId, trimmed)
    }, [])

    const remove = useCallback(async (folderId: string) => {
        setSessionFolders(prev => prev.filter(f => f.id !== folderId))
        setWorkspaces(prev => withSessionFolders(prev, current => current === folderId ? undefined : current))
        await window.api.removeSessionFolder(folderId)
    }, [setWorkspaces])

    const setExpanded = useCallback(async (folderIds: string[], expanded: boolean) => {
        if (folderIds.length === 0) return
        const targets = new Set(folderIds)
        setSessionFolders(prev => prev.map(f => targets.has(f.id) ? { ...f, isExpanded: expanded } : f))
        await window.api.setSessionFoldersExpanded(folderIds, expanded)
    }, [])

    const toggleExpanded = useCallback(async (folderId: string) => {
        const folder = foldersRef.current.find(f => f.id === folderId)
        if (!folder) return
        foldersRef.current = foldersRef.current.map(f => f.id === folderId ? { ...f, isExpanded: !folder.isExpanded } : f)
        await setExpanded([folderId], !folder.isExpanded)
    }, [setExpanded])

    const moveSession = useCallback(async (sessionId: string, folderId: string | null) => {
        setWorkspaces(prev => withSessionFolders(prev, (current, id) => id === sessionId ? (folderId ?? undefined) : current))
        await window.api.moveSessionToSessionFolder(sessionId, folderId)
    }, [setWorkspaces])

    const actions: SessionFolderActions = { create, rename, remove, toggleExpanded, setExpanded, moveSession }
    return { sessionFolders, actions }
}
