import { MAX_LINKED_SESSIONS } from './sessionLink'

/**
 * What a session dropped on the terminal area does to split view.
 *
 * A session may appear in split view only once: App.tsx draws one TerminalView per session and
 * places it in the first pane that lists it, so a second pane with the same id stays empty
 * (report d2e6adc7 — dragging the session already on screen onto itself made [A, A]).
 */
export type SplitDropResult =
    | { kind: 'ignore' }
    | { kind: 'focus'; index: number }
    | { kind: 'layout'; sessionIds: string[] }

export function splitAfterDrop(
    currentIds: string[] | null,
    activeSessionId: string | null,
    droppedId: string
): SplitDropResult {
    if (currentIds) {
        const existing = currentIds.indexOf(droppedId)
        // Already in a pane: bring that pane forward instead of adding a second, empty copy.
        if (existing >= 0) return { kind: 'focus', index: existing }
        if (currentIds.length >= MAX_LINKED_SESSIONS) return { kind: 'ignore' }
        return { kind: 'layout', sessionIds: [...currentIds, droppedId] }
    }
    // The session already filling the screen: there is nothing to split.
    if (activeSessionId === droppedId) return { kind: 'ignore' }
    return { kind: 'layout', sessionIds: activeSessionId ? [activeSessionId, droppedId] : [droppedId] }
}

/** Width of the line between split panes. Panes touch it on both sides — no other gap. */
export const SPLIT_DIVIDER_PX = 1
