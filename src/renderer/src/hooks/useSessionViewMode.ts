import { useSyncExternalStore } from 'react'

/**
 * Terminal or Chat, per session — remembered across restarts (localStorage
 * `session-view-modes`). A module store, so a header button and the session's
 * terminal slot read the same value without going through App state (which
 * would re-render every terminal on each toggle).
 */
export type SessionViewMode = 'terminal' | 'chat'

const STORAGE_KEY = 'session-view-modes'

function load(): Record<string, SessionViewMode> {
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as unknown
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
        const modes: Record<string, SessionViewMode> = {}
        for (const [id, mode] of Object.entries(parsed as Record<string, unknown>)) {
            if (mode === 'chat') modes[id] = 'chat'
        }
        return modes
    } catch {
        return {}
    }
}

let modes = load()
const listeners = new Set<() => void>()

function save(): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(modes))
    } catch {
        // storage full or blocked: the choice still holds for this run
    }
}

export function getSessionViewMode(sessionId: string): SessionViewMode {
    return modes[sessionId] ?? 'terminal'
}

export function setSessionViewMode(sessionId: string, mode: SessionViewMode): void {
    // going back to the chat (by any way) ends a peek
    if (mode === 'chat') setSessionPeek(sessionId, null)
    if (getSessionViewMode(sessionId) === mode) return
    const next = { ...modes }
    // Terminal is the default: only Chat is stored, so closed sessions leave little behind.
    if (mode === 'chat') next[sessionId] = 'chat'
    else delete next[sessionId]
    modes = next
    save()
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function useSessionViewMode(sessionId: string | undefined): SessionViewMode {
    return useSyncExternalStore(subscribe, () => (sessionId ? getSessionViewMode(sessionId) : 'terminal'))
}

/**
 * Sessions created from a template that opens in Chat (`TerminalSession.openInChat`) are switched to Chat
 * the first time they are seen, once (fbe10f54). The ids handled are kept (localStorage), so a session the
 * person later put back on its terminal stays there after a restart, and sessions that already existed
 * when the template got the setting are never touched (the flag is set at creation only).
 */
const OPEN_IN_APPLIED_KEY = 'session-open-in-applied'

export function applyOpenInChat(sessions: Array<{ id: string; openInChat?: boolean }>): void {
    let applied: string[] = []
    try {
        const parsed = JSON.parse(localStorage.getItem(OPEN_IN_APPLIED_KEY) ?? '[]') as unknown
        if (Array.isArray(parsed)) applied = parsed.filter((id): id is string => typeof id === 'string')
    } catch {
        applied = []
    }
    const known = new Set(applied)
    const flagged = sessions.filter((session) => session.openInChat)
    const fresh = flagged.filter((session) => !known.has(session.id))
    for (const session of fresh) setSessionViewMode(session.id, 'chat')
    // only ids of sessions that still exist stay: closed ones leave nothing behind
    const next = flagged.map((session) => session.id)
    if (fresh.length === 0 && next.length === applied.length) return
    try {
        localStorage.setItem(OPEN_IN_APPLIED_KEY, JSON.stringify(next))
    } catch {
        // not kept: a restart could switch these sessions to Chat once more
    }
}

/*
 * "Peek": a command only the terminal can show (`/config`, a bare `/model`) was sent from the
 * chat, so the session switched to its terminal. The terminal then carries a "Back to Chat" bar
 * until the person goes back or keeps the terminal (ovis terminalPeek). Not remembered across
 * restarts — it belongs to one moment.
 */
const peeks = new Map<string, string>()
const peekListeners = new Set<() => void>()
let peekVersion = 0

export function setSessionPeek(sessionId: string, command: string | null): void {
    if (command === null ? !peeks.has(sessionId) : peeks.get(sessionId) === command) return
    if (command === null) peeks.delete(sessionId)
    else peeks.set(sessionId, command)
    peekVersion++
    for (const listener of peekListeners) listener()
}

function subscribePeek(listener: () => void): () => void {
    peekListeners.add(listener)
    return () => peekListeners.delete(listener)
}

export function useSessionPeek(sessionId: string | undefined): string | null {
    useSyncExternalStore(subscribePeek, () => peekVersion)
    return sessionId ? peeks.get(sessionId) ?? null : null
}
