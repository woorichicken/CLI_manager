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

/**
 * A pane at least this wide gets the single-view header row (report 08343040). The single header's
 * controls — path, Terminal/Chat, parent shortcut, Related, five icon buttons — need about this much;
 * below it the compact row keeps the session name readable.
 */
export const WIDE_PANE_HEADER_MIN_PX = 640
/** Header heights: the single view's h-10 for a wide pane, the compact h-8 otherwise. */
export const PANE_HEADER_WIDE_PX = 40
export const PANE_HEADER_COMPACT_PX = 32

/** Width of pane `index` in a split of `count` inside an area `areaWidth` wide (see App getSplitStyle). */
export function splitPaneWidth(areaWidth: number, count: number, index: number): number {
    const half = (areaWidth - SPLIT_DIVIDER_PX) / 2
    if (count <= 1) return areaWidth
    if (count === 3 && index === 2) return areaWidth // the bottom pane spans both columns
    return half
}

/**
 * One header shape for the whole split: the wide row only when every pane is wide enough. Deciding
 * per pane mixed two shapes on one screen (1280, three panes: compact on top, wide below), which is
 * the very difference report 08343040 complained about. So the narrowest pane decides.
 */
export function splitHeadersWide(areaWidth: number, count: number): boolean {
    if (areaWidth <= 0 || count < 1) return false
    const narrowest = Math.min(...Array.from({ length: count }, (_, index) => splitPaneWidth(areaWidth, count, index)))
    return narrowest >= WIDE_PANE_HEADER_MIN_PX
}
