import { test, expect } from '@playwright/test'
import {
    closeSessionTab,
    keepSessionTab,
    moveSessionTab,
    normalizeSessionTabs,
    openSessionTab,
    previewSessionTab,
    pruneSessionTabs,
    showSessionTabs,
    stepSessionTab,
    withTabIds,
    tabsToClose,
    SESSION_TABS_KEY,
} from '../../src/shared/sessionTabs'
import { SessionTabs } from '../../src/main/SessionTabs'

/**
 * T149 unit — the tab row's rules (shared/sessionTabs.ts) and its storage in main,
 * without Electron. The app side is t149-session-tabs.spec.ts.
 */

function fakeStore(initial: Record<string, unknown> = {}) {
    const data: Record<string, unknown> = { ...initial }
    let writes = 0
    return {
        get: (key: string) => data[key],
        set: (key: string, value: unknown) => { data[key] = value; writes++ },
        data,
        writes: () => writes,
    }
}

test.describe('T149 session tabs unit', () => {
    test('a new tab opens right after the one the person was on; an open tab stays put', () => {
        expect(openSessionTab([], 'a', null)).toEqual(['a'])
        expect(openSessionTab(['a', 'b', 'c'], 'x', 'a')).toEqual(['a', 'x', 'b', 'c'])
        expect(openSessionTab(['a', 'b', 'c'], 'x', 'c')).toEqual(['a', 'b', 'c', 'x'])
        // Was on nothing, or on a tab already closed: the end.
        expect(openSessionTab(['a', 'b'], 'x', null)).toEqual(['a', 'b', 'x'])
        expect(openSessionTab(['a', 'b'], 'x', 'gone')).toEqual(['a', 'b', 'x'])
        const ids = ['a', 'b', 'c']
        expect(openSessionTab(ids, 'b', 'a')).toBe(ids)
    })

    test('closing a tab lands on the one to its right, else its left, else none', () => {
        expect(closeSessionTab(['a', 'b', 'c'], 'b')).toEqual({ ids: ['a', 'c'], neighbor: 'c' })
        expect(closeSessionTab(['a', 'b', 'c'], 'c')).toEqual({ ids: ['a', 'b'], neighbor: 'b' })
        expect(closeSessionTab(['a'], 'a')).toEqual({ ids: [], neighbor: null })
        const ids = ['a', 'b']
        expect(closeSessionTab(ids, 'x')).toEqual({ ids, neighbor: null })
    })

    test('⌘> / ⌘< step through the tabs and wrap round', () => {
        const ids = ['a', 'b', 'c']
        expect(stepSessionTab(ids, 'a', 1)).toBe('b')
        expect(stepSessionTab(ids, 'c', 1)).toBe('a')
        expect(stepSessionTab(ids, 'a', -1)).toBe('c')
        // Not on a tab (a session with the row off, an empty screen): the first or last.
        expect(stepSessionTab(ids, null, 1)).toBe('a')
        expect(stepSessionTab(ids, 'x', -1)).toBe('c')
        expect(stepSessionTab([], 'a', 1)).toBeNull()
    })

    test('a drag moves a tab; a drop on its own place changes nothing', () => {
        expect(moveSessionTab(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a'])
        expect(moveSessionTab(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b'])
        expect(moveSessionTab(['a', 'b', 'c'], 'b', 99)).toEqual(['a', 'c', 'b'])
        const ids = ['a', 'b', 'c']
        expect(moveSessionTab(ids, 'b', 1)).toBe(ids)
        expect(moveSessionTab(ids, 'x', 0)).toBe(ids)
    })

    test('the tab menu closes the others, the ones to the right, or all', () => {
        const ids = ['a', 'b', 'c', 'd']
        expect(tabsToClose(ids, 'b', 'others')).toEqual(['a', 'c', 'd'])
        expect(tabsToClose(ids, 'b', 'right')).toEqual(['c', 'd'])
        expect(tabsToClose(ids, 'd', 'right')).toEqual([])
        expect(tabsToClose(ids, 'x', 'right')).toEqual([])
        expect(tabsToClose(ids, 'b', 'all')).toEqual(ids)
        expect(tabsToClose(['a'], 'a', 'others')).toEqual([])
    })

    test('stored values of the wrong shape become no tabs; the active tab must be one of them', () => {
        expect(normalizeSessionTabs(undefined)).toEqual({ ids: [], activeId: null, previewIds: [] })
        expect(normalizeSessionTabs('x')).toEqual({ ids: [], activeId: null, previewIds: [] })
        expect(normalizeSessionTabs({ ids: ['a', 3, '', 'b', 'a'], activeId: 'b' })).toEqual({ ids: ['a', 'b'], activeId: 'b', previewIds: [] })
        expect(normalizeSessionTabs({ ids: ['a'], activeId: 'gone' })).toEqual({ ids: ['a'], activeId: null, previewIds: [] })
        expect(normalizeSessionTabs({ ids: 'a', activeId: 'a' })).toEqual({ ids: [], activeId: null, previewIds: [] })
        // preview marks only for tabs that exist; junk dropped
        expect(normalizeSessionTabs({ ids: ['a', 'b'], activeId: 'b', previewIds: ['b', 'gone', 7, 'b'] }))
            .toEqual({ ids: ['a', 'b'], activeId: 'b', previewIds: ['b'] })
    })

    test('a value saved before preview tabs reads as all kept: existing tabs stay when another session shows', () => {
        const old = normalizeSessionTabs({ ids: ['a', 'b', 'c'], activeId: 'b' })
        expect(old.previewIds).toEqual([])
        const next = showSessionTabs(old, ['d'], 'd', true)
        expect(next.ids).toEqual(['a', 'b', 'd', 'c'])
        expect(next.previewIds).toEqual(['d'])
    })

    test('preview: walking through sessions leaves one tab, in the same place', () => {
        let state = normalizeSessionTabs({ ids: ['k1', 'k2'], activeId: 'k1' })
        state = showSessionTabs(state, ['a'], 'a', true)
        expect(state).toEqual({ ids: ['k1', 'a', 'k2'], activeId: 'a', previewIds: ['a'] })
        state = showSessionTabs(state, ['b'], 'b', true)
        expect(state).toEqual({ ids: ['k1', 'b', 'k2'], activeId: 'b', previewIds: ['b'] })
        state = showSessionTabs(state, ['c'], 'c', true)
        expect(state).toEqual({ ids: ['k1', 'c', 'k2'], activeId: 'c', previewIds: ['c'] })
        // back to a kept tab: the preview, no longer on screen, closes
        state = showSessionTabs(state, ['k2'], 'k2', true)
        expect(state).toEqual({ ids: ['k1', 'k2'], activeId: 'k2', previewIds: [] })
        // showing the same thing again changes nothing (same object, no save)
        expect(showSessionTabs(state, ['k2'], 'k2', true)).toBe(state)
    })

    test('preview: a kept tab stays when the next session shows; nothing on screen closes nothing', () => {
        let state = showSessionTabs(normalizeSessionTabs(undefined), ['a'], 'a', true)
        state = keepSessionTab(state, 'a')
        expect(state.previewIds).toEqual([])
        expect(keepSessionTab(state, 'a')).toBe(state)
        state = showSessionTabs(state, ['b'], 'b', true)
        expect(state).toEqual({ ids: ['a', 'b'], activeId: 'b', previewIds: ['b'] })
        // start-up, before the restored tab is on screen: the preview tab must survive
        expect(showSessionTabs(state, [], null, true)).toBe(state)
    })

    test('make preview: a kept tab on screen becomes a preview again, in place; anything else changes nothing', () => {
        let state = normalizeSessionTabs({ ids: ['k1', 'k2', 'k3'], activeId: 'k2' })
        // off screen / unknown / already a preview: the same object
        expect(previewSessionTab(state, 'k1', ['k2'])).toBe(state)
        expect(previewSessionTab(state, 'zz', ['zz'])).toBe(state)
        state = previewSessionTab(state, 'k2', ['k2'])
        expect(state).toEqual({ ids: ['k1', 'k2', 'k3'], activeId: 'k2', previewIds: ['k2'] })
        expect(previewSessionTab(state, 'k2', ['k2'])).toBe(state)
        // the next session shown takes its slot
        state = showSessionTabs(state, ['n'], 'n', true)
        expect(state).toEqual({ ids: ['k1', 'n', 'k3'], activeId: 'n', previewIds: ['n'] })
    })

    test('make preview in split view: the marked pane is replaced when it changes; the other preview pane stays', () => {
        let state = showSessionTabs(normalizeSessionTabs({ ids: ['k'], activeId: 'k' }), ['k', 'a'], 'k', true)
        expect(state.previewIds).toEqual(['a'])
        state = previewSessionTab(state, 'k', ['k', 'a'])
        expect(state.previewIds).toEqual(['k', 'a'])
        state = showSessionTabs(state, ['c', 'a'], 'c', true)
        expect(state).toEqual({ ids: ['c', 'a'], activeId: 'c', previewIds: ['c', 'a'] })
    })

    test('preview in split view: each new pane gets a preview; a pane replaced takes its slot; a pane that leaves closes it', () => {
        let state = normalizeSessionTabs({ ids: ['k'], activeId: 'k' })
        state = showSessionTabs(state, ['k', 'a', 'b'], 'k', true)
        expect(state).toEqual({ ids: ['k', 'a', 'b'], activeId: 'k', previewIds: ['a', 'b'] })
        // the focused pane 'a' becomes 'c'
        state = showSessionTabs(state, ['k', 'c', 'b'], 'c', true)
        expect(state).toEqual({ ids: ['k', 'c', 'b'], activeId: 'c', previewIds: ['c', 'b'] })
        // pane 'b' leaves split view
        state = showSessionTabs(state, ['k', 'c'], 'c', true)
        expect(state).toEqual({ ids: ['k', 'c'], activeId: 'c', previewIds: ['c'] })
    })

    test('preview off: every session shown keeps a tab, and preview marks turn into kept tabs', () => {
        let state = showSessionTabs(normalizeSessionTabs(undefined), ['a'], 'a', true)
        state = showSessionTabs(state, ['b'], 'b', false)
        expect(state).toEqual({ ids: ['a', 'b'], activeId: 'b', previewIds: [] })
        state = showSessionTabs(state, ['c'], 'c', false)
        expect(state.ids).toEqual(['a', 'b', 'c'])
    })

    test('withTabIds drops the preview marks and the active tab of tabs that left', () => {
        const state = { ids: ['a', 'b', 'c'], activeId: 'b', previewIds: ['b'] }
        expect(withTabIds(state, ['a', 'c'])).toEqual({ ids: ['a', 'c'], activeId: null, previewIds: [] })
        expect(withTabIds(state, state.ids)).toBe(state)
    })

    test('prune keeps the same array when nothing went, so callers skip a write', () => {
        const ids = ['a', 'b']
        expect(pruneSessionTabs(ids, () => true)).toBe(ids)
        expect(pruneSessionTabs(ids, (id) => id !== 'a')).toEqual(['b'])
    })

    test('main storage: save, forget a closed session, prune at startup', () => {
        const store = fakeStore()
        const tabs = new SessionTabs(store)
        expect(tabs.get()).toEqual({ ids: [], activeId: null, previewIds: [] })

        tabs.set({ ids: ['a', 'b', 'c'], activeId: 'b', extra: 'dropped' })
        expect(store.data[SESSION_TABS_KEY]).toEqual({ ids: ['a', 'b', 'c'], activeId: 'b', previewIds: [] })

        // Closing the active session also clears the tab to restore.
        tabs.forget('b')
        expect(tabs.get()).toEqual({ ids: ['a', 'c'], activeId: null, previewIds: [] })

        const before = store.writes()
        tabs.forget('not-a-tab')
        tabs.prune(new Set(['a', 'c']))
        expect(store.writes()).toBe(before)

        tabs.set({ ids: ['a', 'c'], activeId: 'c' })
        tabs.prune(new Set(['c']))
        expect(tabs.get()).toEqual({ ids: ['c'], activeId: 'c', previewIds: [] })

        // forget/prune keep the preview marks of tabs that stay (a plain { ids, activeId } write dropped them)
        tabs.set({ ids: ['a', 'p', 'c'], activeId: 'p', previewIds: ['p'] })
        tabs.forget('a')
        expect(tabs.get()).toEqual({ ids: ['p', 'c'], activeId: 'p', previewIds: ['p'] })
        tabs.prune(new Set(['c']))
        expect(tabs.get()).toEqual({ ids: ['c'], activeId: null, previewIds: [] })
    })
})
