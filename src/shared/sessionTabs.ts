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
    /**
     * Preview tabs (a subset of `ids`): opened but not kept. A preview tab lives only while its session
     * is on screen — the next session shown takes its place. Dragging it, renaming it or
     * right-click › Keep Open keeps it; typing in its session does not (a keystroke is not a choice). Absent in values saved before preview tabs: every tab is kept,
     * so tabs people already had stay put.
     */
    previewIds: string[]
}

export const EMPTY_SESSION_TABS: SessionTabsState = { ids: [], activeId: null, previewIds: [] }

function stringIds(raw: unknown): string[] {
    return Array.isArray(raw) ? [...new Set(raw.filter((id): id is string => typeof id === 'string' && id.length > 0))] : []
}

/** Reads a stored value: anything that is not the expected shape becomes no tabs. Duplicates keep their first place. */
export function normalizeSessionTabs(raw: unknown): SessionTabsState {
    if (!raw || typeof raw !== 'object') return EMPTY_SESSION_TABS
    const value = raw as { ids?: unknown; activeId?: unknown; previewIds?: unknown }
    const ids = stringIds(value.ids)
    const activeId = typeof value.activeId === 'string' && ids.includes(value.activeId) ? value.activeId : null
    const previewIds = stringIds(value.previewIds).filter((id) => ids.includes(id))
    return { ids, activeId, previewIds }
}

/**
 * The same tabs with `ids` replaced: preview marks of tabs that left go too, and the tab on screen
 * stays only if it is still a tab. Returns `state` itself when nothing changed.
 */
export function withTabIds(state: SessionTabsState, ids: string[], activeId: string | null = state.activeId): SessionTabsState {
    const nextActive = activeId && ids.includes(activeId) ? activeId : null
    const previewIds = state.previewIds.filter((id) => ids.includes(id))
    const same = ids === state.ids && nextActive === state.activeId && previewIds.length === state.previewIds.length
    return same ? state : { ids, activeId: nextActive, previewIds }
}

/**
 * The sessions on screen changed (`onScreen`: the one session, or the split panes left to right).
 *
 * Kept tabs stay where they are. A session without a tab gets one: with `preview` on it is a preview
 * tab and takes the place of a preview tab that just left the screen (the way VS Code reuses its
 * preview tab), else it goes right after the tab the person was on. Preview tabs no longer on screen
 * close. Nothing on screen (start-up, before the restored tab shows) closes nothing.
 * With `preview` off every new tab is kept and existing preview tabs are kept too.
 */
export function showSessionTabs(state: SessionTabsState, onScreen: string[], viewedId: string | null, preview: boolean): SessionTabsState {
    if (!preview) {
        let ids = state.ids
        let after = state.activeId
        for (const id of onScreen) {
            ids = openSessionTab(ids, id, after)
            after = id
        }
        const activeId = viewedId ?? state.activeId
        if (ids === state.ids && activeId === state.activeId && state.previewIds.length === 0) return state
        return { ids, activeId, previewIds: [] }
    }
    if (onScreen.length === 0) return state
    const shown = new Set(onScreen)
    // preview tabs that just left the screen, left to right — their places are reused first
    const leaving = state.previewIds.filter((id) => !shown.has(id))
    const freeSlots = state.ids.filter((id) => leaving.includes(id))
    let ids = state.ids
    let after = state.activeId
    const previewIds = state.previewIds.filter((id) => shown.has(id))
    for (const id of onScreen) {
        if (!ids.includes(id)) {
            const slot = freeSlots.shift()
            ids = slot ? ids.map((tab) => (tab === slot ? id : tab)) : openSessionTab(ids, id, after)
            previewIds.push(id)
        }
        after = id
    }
    const gone = new Set(leaving)
    const kept = ids.filter((id) => !gone.has(id))
    if (kept.length !== ids.length) ids = kept
    // left to right, like the tabs — a stable order so an unchanged screen compares equal
    const marked = new Set(previewIds)
    const previewInOrder = ids.filter((id) => marked.has(id))
    const activeId = viewedId ?? (state.activeId && ids.includes(state.activeId) ? state.activeId : null)
    const same = ids === state.ids && activeId === state.activeId
        && previewInOrder.length === state.previewIds.length && previewInOrder.every((id, i) => id === state.previewIds[i])
    return same ? state : { ids, activeId, previewIds: previewInOrder }
}

/** Keeps a preview tab (it stays when another session takes the screen). Returns `state` when it was not a preview. */
export function keepSessionTab(state: SessionTabsState, id: string): SessionTabsState {
    if (!state.previewIds.includes(id)) return state
    return { ...state, previewIds: state.previewIds.filter((tab) => tab !== id) }
}

/**
 * Makes a kept tab a preview again (right-click › Make Preview). Only a tab on screen can be one — a
 * preview lives while its session is shown, and a pane holds one session, so the next session shown
 * takes its place by `showSessionTabs`. Returns `state` itself when `id` is not a kept tab or is off screen.
 */
export function previewSessionTab(state: SessionTabsState, id: string, onScreen: string[]): SessionTabsState {
    if (!state.ids.includes(id) || state.previewIds.includes(id) || !onScreen.includes(id)) return state
    const marked = new Set([...state.previewIds, id])
    return { ...state, previewIds: state.ids.filter((tab) => marked.has(tab)) }
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
