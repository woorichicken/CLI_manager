import { randomUUID } from 'crypto'
import { SessionFolder, Workspace } from '../shared/types'

export const SESSION_FOLDERS_KEY = 'sessionFolders'

/** The slice of electron-store this needs; a plain object stands in for it in unit tests. */
export interface SessionFolderStore {
    get(key: string): unknown
    set(key: string, value: unknown): void
}

/**
 * Folders of sessions for the sidebar's "All sessions" view (report 078ee766).
 *
 * A session keeps its workspace and may also sit in one session folder: the
 * folder list lives under `sessionFolders`, the membership on the session as
 * `sessionFolderId`. Builds before 1.20 know neither field and leave both alone.
 */
export class SessionFolders {
    constructor(private readonly store: SessionFolderStore) {}

    list(): SessionFolder[] {
        const stored = this.store.get(SESSION_FOLDERS_KEY)
        return Array.isArray(stored) ? (stored as SessionFolder[]) : []
    }

    create(name: string, now = Date.now()): SessionFolder | null {
        const trimmed = typeof name === 'string' ? name.trim() : ''
        if (!trimmed) return null
        const folder: SessionFolder = { id: randomUUID(), name: trimmed, isExpanded: true, createdAt: now }
        this.store.set(SESSION_FOLDERS_KEY, [...this.list(), folder])
        return folder
    }

    rename(folderId: string, name: string): boolean {
        const trimmed = typeof name === 'string' ? name.trim() : ''
        if (!trimmed) return false
        return this.update(folderId, folder => ({ ...folder, name: trimmed }))
    }

    /**
     * Deletes the folder only: its sessions stay open and go back to "No folder". Sessions still
     * naming it are cleared even when the folder itself is already gone (another window, an old build).
     */
    remove(folderId: string): boolean {
        const folders = this.list()
        const listed = folders.some(f => f.id === folderId)
        if (listed) this.store.set(SESSION_FOLDERS_KEY, folders.filter(f => f.id !== folderId))
        const workspaces = this.workspaces()
        let changed = false
        for (const workspace of workspaces) {
            for (const session of workspace.sessions ?? []) {
                if (session.sessionFolderId === folderId) {
                    delete session.sessionFolderId
                    changed = true
                }
            }
        }
        if (changed) this.store.set('workspaces', workspaces)
        return listed || changed
    }

    setExpanded(folderIds: string[], expanded: boolean): boolean {
        const targets = new Set(folderIds)
        const folders = this.list()
        if (!folders.some(f => targets.has(f.id))) return false
        this.store.set(SESSION_FOLDERS_KEY, folders.map(f => targets.has(f.id) ? { ...f, isExpanded: expanded } : f))
        return true
    }

    /** Puts a session in a folder, or takes it out with `null`. A session is in one folder at most. */
    moveSession(sessionId: string, folderId: string | null): boolean {
        if (folderId !== null && !this.list().some(f => f.id === folderId)) return false
        const workspaces = this.workspaces()
        for (const workspace of workspaces) {
            const session = workspace.sessions?.find(s => s.id === sessionId)
            if (!session) continue
            if (folderId) session.sessionFolderId = folderId
            else delete session.sessionFolderId
            this.store.set('workspaces', workspaces)
            return true
        }
        return false
    }

    private update(folderId: string, change: (folder: SessionFolder) => SessionFolder): boolean {
        const folders = this.list()
        if (!folders.some(f => f.id === folderId)) return false
        this.store.set(SESSION_FOLDERS_KEY, folders.map(f => f.id === folderId ? change(f) : f))
        return true
    }

    private workspaces(): Workspace[] {
        const stored = this.store.get('workspaces')
        return Array.isArray(stored) ? (stored as Workspace[]) : []
    }
}
