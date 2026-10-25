import { randomUUID } from 'crypto'
import { INBOX_KINDS, InboxKind, InboxRequest } from '../shared/types'
import type { RelationStore } from './SessionRelations'

export const INBOX_KEY = 'inbox'
export const INBOX_CHANNEL = 'inbox'

/** The list keeps at most this many requests; read ones go first when it overflows. */
export const INBOX_MAX_REQUESTS = 200
/** Read requests older than this are dropped at startup. Re-reading an old request is rare. */
export const INBOX_READ_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** One line in the inbox list. Longer text is cut, not refused: the agent's request still arrives. */
export const INBOX_TEXT_MAX = 200
export const INBOX_URL_MAX = 2000

/**
 * Schemes that run code inside the window or carry inline content. Refused by the API
 * outright; every other scheme is decided when the user clicks, by the same rule as a
 * terminal link (renderer utils/terminalLinks.ts), so the Settings list applies to both.
 */
const RESERVED_URL_SCHEMES: ReadonlySet<string> = new Set(['javascript:', 'data:', 'vbscript:', 'blob:', 'about:'])

export interface InboxInput {
    kind?: unknown
    text?: unknown
    url?: unknown
}

export type InboxCheck =
    | { ok: true; kind: InboxKind; text: string; url?: string }
    | { ok: false; message: string }

/**
 * Validates what a caller sent. Kind defaults to `other`; text is required and
 * folded to one line; url is optional and must parse, fit 2000 characters and
 * not use a reserved scheme.
 */
export function checkInboxInput(input: InboxInput): InboxCheck {
    let kind: InboxKind = 'other'
    if (input.kind !== undefined && input.kind !== null) {
        if (typeof input.kind !== 'string' || !(INBOX_KINDS as readonly string[]).includes(input.kind)) {
            return { ok: false, message: `kind must be one of ${INBOX_KINDS.join(', ')}` }
        }
        kind = input.kind as InboxKind
    }

    if (typeof input.text !== 'string') return { ok: false, message: 'text is required' }
    const text = input.text.replace(/\s+/g, ' ').trim().slice(0, INBOX_TEXT_MAX).trim()
    if (!text) return { ok: false, message: 'text is required' }

    if (input.url === undefined || input.url === null || input.url === '') return { ok: true, kind, text }
    if (typeof input.url !== 'string') return { ok: false, message: 'url must be a string' }
    const url = input.url.trim()
    if (url.length > INBOX_URL_MAX) return { ok: false, message: `url is limited to ${INBOX_URL_MAX} characters` }
    let protocol: string
    try {
        protocol = new URL(url).protocol
    } catch {
        return { ok: false, message: 'url must be an absolute URL (e.g. https://…)' }
    }
    if (RESERVED_URL_SCHEMES.has(protocol)) return { ok: false, message: `"${protocol}" links are not allowed` }
    return { ok: true, kind, text, url }
}

/**
 * Requests sessions send for the user's hands — sign in, review, answer — shown in
 * the app's inbox until the user looks at that session. Kept in electron-store so
 * an unread request survives a restart; announced with `onChange`, which main
 * broadcasts to every window and turns into the Dock badge.
 *
 * Newest first. A request is tied to its session and goes when the session goes.
 */
export class InboxStore {
    constructor(
        private readonly store: RelationStore,
        private readonly onChange: (requests: InboxRequest[]) => void = () => {}
    ) {}

    list(options: { unreadOnly?: boolean } = {}): InboxRequest[] {
        const all = this.all()
        return options.unreadOnly ? all.filter((r) => !r.readAt) : all
    }

    unreadCount(): number {
        return this.all().filter((r) => !r.readAt).length
    }

    /**
     * A session asked for something. The same unread line from the same session
     * (same kind, same text) is not added twice — an agent waiting in a loop may
     * repeat itself — it moves to the top with the new time and the newest link.
     */
    add(
        input: { sessionId: string; kind: InboxKind; text: string; url?: string; client: string },
        now = Date.now()
    ): { request: InboxRequest; created: boolean } {
        const all = this.all()
        const repeat = all.find(
            (r) => !r.readAt && r.sessionId === input.sessionId && r.kind === input.kind && r.text === input.text
        )
        if (repeat) {
            const updated: InboxRequest = { ...repeat, at: now, ...(input.url ? { url: input.url } : {}) }
            this.save([updated, ...all.filter((r) => r.id !== repeat.id)])
            return { request: updated, created: false }
        }

        const request: InboxRequest = {
            id: randomUUID(),
            sessionId: input.sessionId,
            kind: input.kind,
            text: input.text,
            ...(input.url ? { url: input.url } : {}),
            at: now,
            createdAt: now,
            client: input.client
        }
        this.save(trimToCap([request, ...all]))
        return { request, created: true }
    }

    /** Null when no request has this id. Reading a read request changes nothing. */
    markRead(id: string, now = Date.now()): InboxRequest | null {
        const all = this.all()
        const target = all.find((r) => r.id === id)
        if (!target) return null
        if (target.readAt) return target
        const updated = { ...target, readAt: now }
        this.save(all.map((r) => (r.id === id ? updated : r)))
        return updated
    }

    /** The user is looking at these sessions: whatever they asked for has been seen. */
    markSessionsRead(sessionIds: readonly string[], now = Date.now()): number {
        const ids = new Set(sessionIds)
        return this.markWhere((r) => ids.has(r.sessionId), now)
    }

    markAllRead(now = Date.now()): number {
        return this.markWhere(() => true, now)
    }

    /** A session closed or was deleted: its requests have nowhere to lead. */
    forget(sessionId: string): void {
        const all = this.all()
        const next = all.filter((r) => r.sessionId !== sessionId)
        if (next.length !== all.length) this.save(next)
    }

    /** Startup: drops requests of sessions that no longer exist, and read ones past the retention. */
    prune(existingSessionIds: Set<string>, now = Date.now()): void {
        const all = this.all()
        const next = all.filter(
            (r) => existingSessionIds.has(r.sessionId) && !(r.readAt && now - r.readAt > INBOX_READ_RETENTION_MS)
        )
        if (next.length !== all.length) this.save(next)
    }

    private markWhere(match: (r: InboxRequest) => boolean, now: number): number {
        let count = 0
        const next = this.all().map((r) => {
            if (r.readAt || !match(r)) return r
            count++
            return { ...r, readAt: now }
        })
        if (count > 0) this.save(next)
        return count
    }

    private all(): InboxRequest[] {
        const stored = this.store.get(INBOX_KEY)
        if (!Array.isArray(stored)) return []
        return (stored as InboxRequest[])
            .filter((r) => r && typeof r.id === 'string' && typeof r.sessionId === 'string')
            .sort((a, b) => b.at - a.at)
    }

    private save(next: InboxRequest[]): void {
        this.store.set(INBOX_KEY, next)
        this.onChange(next)
    }
}

/** Over the cap: the oldest read requests go first, then (only if every one is unread) the oldest unread. */
function trimToCap(newestFirst: InboxRequest[]): InboxRequest[] {
    let excess = newestFirst.length - INBOX_MAX_REQUESTS
    if (excess <= 0) return newestFirst
    const drop = new Set<string>()
    for (let i = newestFirst.length - 1; i >= 0 && excess > 0; i--) {
        if (newestFirst[i].readAt) {
            drop.add(newestFirst[i].id)
            excess--
        }
    }
    for (let i = newestFirst.length - 1; i >= 0 && excess > 0; i--) {
        if (!drop.has(newestFirst[i].id)) {
            drop.add(newestFirst[i].id)
            excess--
        }
    }
    return newestFirst.filter((r) => !drop.has(r.id))
}
