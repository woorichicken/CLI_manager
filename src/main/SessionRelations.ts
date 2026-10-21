import { SessionRelation, SessionRelationKind } from '../shared/types'

export const SESSION_RELATIONS_KEY = 'sessionRelations'
export const SESSION_RELATIONS_CHANNEL = 'session-relations'

/** The slice of electron-store this needs; a plain object stands in for it in unit tests. */
export interface RelationStore {
    get(key: string): unknown
    set(key: string, value: unknown): void
}

function samePair(relation: SessionRelation, a: string, b: string): boolean {
    return (relation.from === a && relation.to === b) || (relation.from === b && relation.to === a)
}

/**
 * Which sessions belong together, for the session header's Related sessions
 * dialog. Kept in electron-store so it survives a restart — the agents that
 * opened the sessions are often still running in them afterwards.
 *
 * One record per pair of sessions. Every change is written through and then
 * announced with `onChange`, which main broadcasts to every window.
 */
export class SessionRelations {
    constructor(
        private readonly store: RelationStore,
        private readonly onChange: (visible: SessionRelation[]) => void = () => {}
    ) {}

    /** Relations to show — everything but the ones the user removed. */
    list(): SessionRelation[] {
        return this.all().filter((r) => !r.dismissed)
    }

    /** `from` opened `to` through the API. `to` is brand new, so nothing can already be recorded for the pair. */
    recordOpened(from: string, to: string, now = Date.now()): void {
        this.put(from, to, 'opened', now)
    }

    /**
     * `from` read or typed into `to` through the API. Only the first contact
     * counts: an existing record — any kind, removed by the user or not — wins.
     */
    recordConnected(from: string, to: string, now = Date.now()): void {
        if (from === to || this.all().some((r) => samePair(r, from, to))) return
        this.put(from, to, 'connected', now)
    }

    /** Added by hand in the dialog of `from`. Restores a pair the user had removed; a pair already shown stays as it is. */
    add(from: string, to: string, now = Date.now()): boolean {
        if (from === to) return false
        const existing = this.all().find((r) => samePair(r, from, to))
        if (existing && !existing.dismissed) return false
        this.put(from, to, 'manual', now)
        return true
    }

    /** Removed by hand. Leaves a marker so the pair is not re-added by the next API call. */
    remove(a: string, b: string): boolean {
        let changed = false
        const next = this.all().map((r) => {
            if (!samePair(r, a, b) || r.dismissed) return r
            changed = true
            return { ...r, dismissed: true }
        })
        if (changed) this.save(next)
        return changed
    }

    /** A session closed or was deleted: every relation it was part of goes with it. */
    forget(sessionId: string): void {
        const all = this.all()
        const next = all.filter((r) => r.from !== sessionId && r.to !== sessionId)
        if (next.length !== all.length) this.save(next)
    }

    /**
     * Startup: drops relations to sessions that no longer exist. A session can
     * vanish without passing through `forget` (the app quit mid-close, a config
     * edited by hand), and a relation to nothing would only clutter the store.
     */
    prune(existingSessionIds: Set<string>): void {
        const all = this.all()
        const next = all.filter((r) => existingSessionIds.has(r.from) && existingSessionIds.has(r.to))
        if (next.length !== all.length) this.save(next)
    }

    private put(from: string, to: string, kind: SessionRelationKind, at: number): void {
        if (from === to) return
        this.save([...this.all().filter((r) => !samePair(r, from, to)), { from, to, kind, at }])
    }

    private all(): SessionRelation[] {
        const stored = this.store.get(SESSION_RELATIONS_KEY)
        return Array.isArray(stored) ? (stored as SessionRelation[]) : []
    }

    private save(next: SessionRelation[]): void {
        this.store.set(SESSION_RELATIONS_KEY, next)
        this.onChange(next.filter((r) => !r.dismissed))
    }
}
