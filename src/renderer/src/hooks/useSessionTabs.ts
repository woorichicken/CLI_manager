import { useCallback, useEffect, useRef, useState } from 'react'
import {
    EMPTY_SESSION_TABS,
    SessionTabsState,
    closeSessionTab,
    moveSessionTab,
    openSessionTab,
    pruneSessionTabs,
} from '../../../shared/sessionTabs'

interface UseSessionTabsConfig {
    /** The main window only: grid and fullscreen windows render App too and must not write the tabs. */
    active: boolean
    /** Settings › Sidebar 「Show Session Tabs」. Off: the row is hidden and nothing new is recorded. */
    enabled: boolean
    /** Sessions are loaded — before that every tab would look like a deleted session. */
    ready: boolean
    /** The session on screen: the active tab, or the focused split pane. */
    viewedSessionId: string | null
    /** Every session on screen — the split view panes, else just the one above. Each gets a tab. */
    onScreenIds: string[]
    sessionExists: (id: string) => boolean
    /** Changes when sessions are added or removed, so closed sessions leave the row. */
    sessionsKey: string
}

export interface SessionTabsApi {
    ids: string[]
    /** Loaded from main — until then the row is empty and nothing is saved. */
    loaded: boolean
    /** Closes a tab (the session keeps running). Returns where to go if it was on screen. */
    closeTab: (id: string) => string | null
    /** Closes several tabs at once (the tab menu's Close Others / to the Right / All). Sessions keep running. */
    closeTabs: (ids: string[]) => void
    moveTab: (id: string, toIndex: number) => void
    /** The tab on screen when the app last saved, once — App shows it after a restart. */
    takeRestoreId: () => string | null
}

/**
 * The tab row at the top of the main area. Every session that comes on screen
 * (sidebar click, link, ⌘T, a split pane) gets a tab next to the one the person
 * was on; the order and the tab on screen are saved in main and come back after
 * a restart. Rules live in `shared/sessionTabs.ts`.
 */
export function useSessionTabs({ active, enabled, ready, viewedSessionId, onScreenIds, sessionExists, sessionsKey }: UseSessionTabsConfig): SessionTabsApi {
    const [state, setState] = useState<SessionTabsState>(EMPTY_SESSION_TABS)
    const [loaded, setLoaded] = useState(false)
    const restoreIdRef = useRef<string | null>(null)
    const restoreTakenRef = useRef(false)
    const sessionExistsRef = useRef(sessionExists)
    sessionExistsRef.current = sessionExists

    useEffect(() => {
        if (!active) return
        let cancelled = false
        window.api.getSessionTabs()
            .then((stored) => {
                if (cancelled) return
                restoreIdRef.current = stored.activeId
                setState(stored)
            })
            .catch(() => {})
            .finally(() => { if (!cancelled) setLoaded(true) })
        return () => { cancelled = true }
    }, [active])

    // A session on screen gets a tab, right after the one the person was on (split panes: one after another).
    const onScreenKey = onScreenIds.join(',')
    useEffect(() => {
        if (!active || !loaded || !enabled) return
        setState((prev) => {
            let ids = prev.ids
            let after = prev.activeId
            for (const id of onScreenKey ? onScreenKey.split(',') : []) {
                ids = openSessionTab(ids, id, after)
                after = id
            }
            const activeId = viewedSessionId ?? prev.activeId
            if (ids === prev.ids && prev.activeId === activeId) return prev
            return { ids, activeId }
        })
    }, [active, loaded, enabled, viewedSessionId, onScreenKey])

    // Closed or deleted sessions leave the row.
    useEffect(() => {
        if (!active || !loaded || !ready) return
        setState((prev) => {
            const ids = pruneSessionTabs(prev.ids, (id) => sessionExistsRef.current(id))
            if (ids === prev.ids) return prev
            return { ids, activeId: prev.activeId && ids.includes(prev.activeId) ? prev.activeId : null }
        })
    }, [active, loaded, ready, sessionsKey])

    // Saved only once sessions are in: a save before the prune could keep ids of deleted sessions.
    useEffect(() => {
        if (!active || !loaded || !ready) return
        void window.api.setSessionTabs(state).catch(() => {})
    }, [active, loaded, ready, state])

    const stateRef = useRef(state)
    stateRef.current = state

    const closeTab = useCallback((id: string): string | null => {
        const current = stateRef.current
        const { ids, neighbor } = closeSessionTab(current.ids, id)
        const activeId = current.activeId === id ? neighbor : current.activeId
        const next = { ids, activeId }
        stateRef.current = next
        setState(next)
        return neighbor
    }, [])

    const closeTabs = useCallback((closing: string[]): void => {
        const gone = new Set(closing)
        const current = stateRef.current
        const ids = current.ids.filter((id) => !gone.has(id))
        if (ids.length === current.ids.length) return
        const next = { ids, activeId: current.activeId && !gone.has(current.activeId) ? current.activeId : null }
        stateRef.current = next
        setState(next)
    }, [])

    const moveTab = useCallback((id: string, toIndex: number) => {
        setState((prev) => {
            const ids = moveSessionTab(prev.ids, id, toIndex)
            return ids === prev.ids ? prev : { ...prev, ids }
        })
    }, [])

    const takeRestoreId = useCallback((): string | null => {
        if (restoreTakenRef.current) return null
        restoreTakenRef.current = true
        return restoreIdRef.current
    }, [])

    return { ids: enabled ? state.ids : [], loaded, closeTab, closeTabs, moveTab, takeRestoreId }
}
