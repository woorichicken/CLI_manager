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
