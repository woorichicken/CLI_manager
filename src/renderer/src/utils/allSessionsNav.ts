/**
 * Cmd+[ / ] in the sidebar's All sessions view (report dc11b60f): step through the rows the
 * user sees, top to bottom, instead of the active workspace's own session order.
 *
 * The sidebar registers its All sessions list element here; the keyboard hook reads the rows
 * from it. Reading the DOM keeps one source for "what is on screen" across List, Tree, session
 * folders and collapsed branches — recomputing it would copy each layout's rules.
 */

let listElement: HTMLElement | null = null
// The session a keyboard step just selected. The list is ordered by recently viewed, so
// reordering it after each step would put that session on top and the next step would
// bounce between the first two rows.
let heldSessionId: string | null = null

/** Called by the sidebar with its All sessions list (null when the list leaves the screen). */
export function setAllSessionsListElement(element: HTMLElement | null): void {
    listElement = element
}

/** Session ids of the All sessions rows in screen order, or null when that list is not shown. */
export function visibleAllSessionsOrder(): string[] | null {
    if (!listElement || !listElement.isConnected) return null
    const ids: string[] = []
    const seen = new Set<string>()
    listElement.querySelectorAll<HTMLElement>('[data-session-item]').forEach(row => {
        const id = row.dataset.sessionItem
        if (id && !seen.has(id)) {
            seen.add(id)
            ids.push(id)
        }
    })
    return ids.length > 0 ? ids : null
}

/**
 * The id one step from `currentId` in `order`, wrapping at both ends. A session that is not
 * in the list (inside a collapsed folder, or none) starts from the top going down and from the
 * bottom going up.
 */
export function stepInOrder(order: string[], currentId: string | null, direction: 1 | -1): string | null {
    if (order.length === 0) return null
    const index = currentId ? order.indexOf(currentId) : -1
    if (index < 0) return direction === 1 ? order[0] : order[order.length - 1]
    return order[(index + direction + order.length) % order.length]
}

/** Marks `sessionId` as selected by a keyboard step, so the list keeps its order for it. */
export function holdOrderFor(sessionId: string): void {
    heldSessionId = sessionId
}

/**
 * True while the active session is the one a keyboard step selected. Any other active session
 * releases the hold, so the next selection made some other way reorders the list as before.
 */
export function isOrderHeldFor(activeSessionId: string | null): boolean {
    if (activeSessionId !== null && heldSessionId === activeSessionId) return true
    heldSessionId = null
    return false
}
