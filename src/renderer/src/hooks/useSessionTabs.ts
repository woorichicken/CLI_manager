import { useCallback, useEffect, useRef, useState } from 'react'
import {
    EMPTY_SESSION_TABS,
    SessionTabsState,
    closeSessionTab,
    keepSessionTab,
    previewSessionTab,
    moveSessionTab,
    pruneSessionTabs,
    showSessionTabs,
    withTabIds,
} from '../../../shared/sessionTabs'

interface UseSessionTabsConfig {
    /** The main window only: grid and fullscreen windows render App too and must not write the tabs. */
    active: boolean
    /** Settings › Sidebar 「Show Session Tabs」. Off: the row is hidden and nothing new is recorded. */
    enabled: boolean
    /** Settings › Sidebar 「Open Sessions as Preview Tabs」: a new tab is a preview the next session replaces. */
    preview: boolean
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
    /** Preview tabs among `ids` — shown in italics; the next session on screen takes their place. */
    previewIds: string[]
    /** Loaded from main — until then the row is empty and nothing is saved. */
    loaded: boolean
    /** Closes a tab (the session keeps running). Returns where to go if it was on screen. */
    closeTab: (id: string) => string | null
    /** Closes several tabs at once (the tab menu's Close Others / to the Right / All). Sessions keep running. */
    closeTabs: (ids: string[]) => void
    /** Moves a tab (a drag) — which also keeps it. */
    moveTab: (id: string, toIndex: number) => void
    /** Keeps a preview tab: right-click › Keep Open or a rename. Typing in its session does not. */
    keepTab: (id: string) => void
    /** Makes a kept tab a preview again (right-click › Unpin) — only one on screen. */
    makePreview: (id: string) => void
    /** The tab on screen when the app last saved, once — App shows it after a restart. */
    takeRestoreId: () => string | null
}

/**
 * The tab row at the top of the main area. Every session that comes on screen
 * (sidebar click, ⌘[ ⌘], a link, ⌘T, a split pane) gets a tab. With preview tabs on
 * (default) that tab is a preview: the next session shown takes its place, so walking
 * through sessions leaves one tab, not one per session; dragging it,
 * renaming it or Keep Open keeps it (typing does not); Unpin undoes a keep. The order, the tab on screen and the preview marks
 * are saved in main and come back after a restart. Rules live in `shared/sessionTabs.ts`.
 */
export function useSessionTabs({ active, enabled, preview, ready, viewedSessionId, onScreenIds, sessionExists, sessionsKey }: UseSessionTabsConfig): SessionTabsApi {
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

    // A session on screen gets a tab — a preview that takes the place of the preview that left (split panes: each).
    const onScreenKey = onScreenIds.join(',')
    useEffect(() => {
        if (!active || !loaded || !enabled) return
        setState((prev) => showSessionTabs(prev, onScreenKey ? onScreenKey.split(',') : [], viewedSessionId, preview))
    }, [active, loaded, enabled, preview, viewedSessionId, onScreenKey])

    // Closed or deleted sessions leave the row.
    useEffect(() => {
        if (!active || !loaded || !ready) return
        setState((prev) => {
            const ids = pruneSessionTabs(prev.ids, (id) => sessionExistsRef.current(id))
            return ids === prev.ids ? prev : withTabIds(prev, ids)
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
        const next = withTabIds(current, ids, activeId)
        stateRef.current = next
        setState(next)
        return neighbor
    }, [])

    const closeTabs = useCallback((closing: string[]): void => {
        const gone = new Set(closing)
        const current = stateRef.current
        const ids = current.ids.filter((id) => !gone.has(id))
        if (ids.length === current.ids.length) return
        const next = withTabIds(current, ids)
        stateRef.current = next
        setState(next)
    }, [])

    const moveTab = useCallback((id: string, toIndex: number) => {
        setState((prev) => {
            // a dragged tab is one the person wants where they put it: it stays
            const kept = keepSessionTab(prev, id)
            const ids = moveSessionTab(kept.ids, id, toIndex)
            return ids === kept.ids ? kept : { ...kept, ids }
        })
    }, [])

    const keepTab = useCallback((id: string) => {
        setState((prev) => keepSessionTab(prev, id))
    }, [])

    const onScreenRef = useRef(onScreenIds)
    onScreenRef.current = onScreenIds
    const makePreview = useCallback((id: string) => {
        setState((prev) => previewSessionTab(prev, id, onScreenRef.current))
    }, [])

    const takeRestoreId = useCallback((): string | null => {
        if (restoreTakenRef.current) return null
        restoreTakenRef.current = true
        return restoreIdRef.current
    }, [])

    return { ids: enabled ? state.ids : [], previewIds: enabled ? state.previewIds : [], loaded, closeTab, closeTabs, moveTab, keepTab, makePreview, takeRestoreId }
}
