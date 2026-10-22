import type { RelationStore } from './SessionRelations'

export const RECENT_SESSIONS_KEY = 'recentSessions'

/** How many sessions the Related dialog's Recent tab remembers. Twenty is a recommendation: change only this. */
export const RECENT_SESSIONS_MAX = 20

/**
 * The sessions the user looked at last, newest first, for the Related dialog's
 * Recent tab. Kept in electron-store so the list is still there after a restart.
 *
 * Only ids are stored; the renderer shows the ones that still exist.
 */
export class RecentSessions {
    constructor(private readonly store: RelationStore) {}

    list(): string[] {
        const stored = this.store.get(RECENT_SESSIONS_KEY)
        return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
    }

    /** `sessionId` is now the one on screen: it goes to the front, once. Already in front means nothing to write. */
    push(sessionId: string): void {
        const current = this.list()
        if (current[0] === sessionId) return
        this.store.set(RECENT_SESSIONS_KEY, [sessionId, ...current.filter((id) => id !== sessionId)].slice(0, RECENT_SESSIONS_MAX))
    }

    /** A session closed or was deleted. */
    forget(sessionId: string): void {
        const current = this.list()
        const next = current.filter((id) => id !== sessionId)
        if (next.length !== current.length) this.store.set(RECENT_SESSIONS_KEY, next)
    }

    /** Startup: drops ids of sessions that no longer exist. */
    prune(existingSessionIds: Set<string>): void {
        const current = this.list()
        const next = current.filter((id) => existingSessionIds.has(id))
        if (next.length !== current.length) this.store.set(RECENT_SESSIONS_KEY, next)
    }
}
