/**
 * A draft per session, kept while the app runs and across restarts
 * (localStorage `chat-drafts`) — switching sessions or views never loses one.
 * Outside the Composer so the view switch can move text in and out of it
 * (4b9cb0c2) while the Composer is not on screen; a mounted Composer hears it.
 */
const DRAFTS_KEY = 'chat-drafts'
const drafts: Record<string, string> = (() => {
    try {
        const parsed = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
    } catch {
        return {}
    }
})()

type Listener = (text: string) => void
const listeners = new Map<string, Set<Listener>>()

export function readDraft(sessionId: string): string {
    return drafts[sessionId] ?? ''
}

/** The Composer's own keystrokes: saved, nobody told (the Composer already shows it). */
export function saveDraft(sessionId: string, text: string): void {
    if (text) drafts[sessionId] = text
    else delete drafts[sessionId]
    try {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
    } catch {
        // storage blocked: the draft still lives in memory
    }
}

/** From outside the Composer (the view switch): saved, and a mounted Composer shows it. */
export function replaceDraft(sessionId: string, text: string): void {
    saveDraft(sessionId, text)
    for (const listener of listeners.get(sessionId) ?? []) listener(text)
}

export function onDraftReplaced(sessionId: string, listener: Listener): () => void {
    let set = listeners.get(sessionId)
    if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
        set.delete(listener)
        if (set.size === 0) listeners.delete(sessionId)
    }
}

/**
 * Puts text after `sessionId`'s saved draft without showing it: a queued message withdrawn for Edit
 * after the view moved to another session goes back to its own session, not into the box on
 * screen (round2 N01).
 */
export function appendDraft(sessionId: string, text: string): void {
    const current = drafts[sessionId] ?? ''
    saveDraft(sessionId, current.trim() ? `${current}\n${text}` : text)
}
