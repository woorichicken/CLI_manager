/**
 * Session tabs: the sessions the person has open in the tab row at the top of
 * the main area, in their order. Separate from the sidebar — the sidebar lists
 * every session; a tab is one the person opened and has not closed. Closing a
 * tab leaves the session running and in the sidebar.
 *
 * Pure functions shared by main (storage) and the renderer (the tab row), so
 * both read the stored value the same way and the rules are tested without Electron.
 */

export const SESSION_TABS_KEY = 'sessionTabs'

export interface SessionTabsState {
    /** Open tabs, left to right. */
    ids: string[]
    /** The tab on screen when the app last saved — shown again after a restart. */
    activeId: string | null
}

export const EMPTY_SESSION_TABS: SessionTabsState = { ids: [], activeId: null }

/** Reads a stored value: anything that is not the expected shape becomes no tabs. Duplicates keep their first place. */
export function normalizeSessionTabs(raw: unknown): SessionTabsState {
    if (!raw || typeof raw !== 'object') return EMPTY_SESSION_TABS
    const value = raw as { ids?: unknown; activeId?: unknown }
    const ids = Array.isArray(value.ids)
        ? [...new Set(value.ids.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        : []
    const activeId = typeof value.activeId === 'string' && ids.includes(value.activeId) ? value.activeId : null
    return { ids, activeId }
}

/**
 * `id` came on screen. A tab already open stays where it is; a new one goes
 * right after `afterId` (the tab the person was on), or at the end — the way a
 * browser opens a tab next to the current one.
 */
export function openSessionTab(ids: string[], id: string, afterId: string | null): string[] {
    if (ids.includes(id)) return ids
    const at = afterId ? ids.indexOf(afterId) : -1
    if (at < 0) return [...ids, id]
    return [...ids.slice(0, at + 1), id, ...ids.slice(at + 1)]
}

/**
 * Closes the tab for `id`. `neighbor` is where to go when it was the one on
 * screen: the tab to its right, else the one to its left, else none.
 */
export function closeSessionTab(ids: string[], id: string): { ids: string[]; neighbor: string | null } {
    const at = ids.indexOf(id)
    if (at < 0) return { ids, neighbor: null }
    const next = ids.filter((tab) => tab !== id)
    return { ids: next, neighbor: next[at] ?? next[at - 1] ?? null }
}

/** The tab `direction` steps from `currentId`, wrapping round. Not on a tab: the first (or last) one. */
export function stepSessionTab(ids: string[], currentId: string | null, direction: 1 | -1): string | null {
    if (ids.length === 0) return null
    const at = currentId ? ids.indexOf(currentId) : -1
    if (at < 0) return direction === 1 ? ids[0] : ids[ids.length - 1]
    return ids[(at + direction + ids.length) % ids.length]
}

/** Moves the tab for `id` to `toIndex` (a drag in the tab row). */
export function moveSessionTab(ids: string[], id: string, toIndex: number): string[] {
    const from = ids.indexOf(id)
    if (from < 0) return ids
    const rest = ids.filter((tab) => tab !== id)
    const at = Math.max(0, Math.min(rest.length, toIndex))
    const next = [...rest.slice(0, at), id, ...rest.slice(at)]
    return next.every((tab, i) => tab === ids[i]) ? ids : next
}

/** Drops tabs whose session no longer exists. Returns the same array when nothing went, so callers can skip a write. */
export function pruneSessionTabs(ids: string[], exists: (id: string) => boolean): string[] {
    const next = ids.filter(exists)
    return next.length === ids.length ? ids : next
}

export type TabCloseScope = 'others' | 'right' | 'all'

/** The tab menu's Close Other Tabs / Close Tabs to the Right / Close All Tabs: which tabs go. */
export function tabsToClose(ids: string[], id: string, scope: TabCloseScope): string[] {
    if (scope === 'all') return [...ids]
    if (scope === 'others') return ids.filter((other) => other !== id)
    const index = ids.indexOf(id)
    return index < 0 ? [] : ids.slice(index + 1)
}
