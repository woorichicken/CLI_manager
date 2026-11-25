import type { RelationStore } from './SessionRelations'
import { SESSION_TABS_KEY, SessionTabsState, normalizeSessionTabs, pruneSessionTabs, withTabIds } from '../shared/sessionTabs'

/**
 * The tab row at the top of the main area (`shared/sessionTabs.ts`), kept in
 * electron-store so the tabs and the one on screen come back after a restart.
 * The renderer owns the order and saves the whole list; main only drops tabs
 * of sessions that are gone.
 */
export class SessionTabs {
    constructor(private readonly store: RelationStore) {}

    get(): SessionTabsState {
        return normalizeSessionTabs(this.store.get(SESSION_TABS_KEY))
    }

    set(raw: unknown): void {
        this.store.set(SESSION_TABS_KEY, normalizeSessionTabs(raw))
    }

    /** A session closed or was deleted. */
    forget(sessionId: string): void {
        this.keepOnly((id) => id !== sessionId)
    }

    /** Startup: drops tabs of sessions that no longer exist. */
    prune(existingSessionIds: Set<string>): void {
        this.keepOnly((id) => existingSessionIds.has(id))
    }

    private keepOnly(keep: (id: string) => boolean): void {
        const current = this.get()
        const ids = pruneSessionTabs(current.ids, keep)
        if (ids === current.ids) return
        // withTabIds keeps the preview marks of the tabs that stay (a plain { ids, activeId } would turn them into kept tabs)
        this.store.set(SESSION_TABS_KEY, withTabIds(current, ids))
    }
}
