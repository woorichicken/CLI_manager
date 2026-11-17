import { test, expect } from '@playwright/test'
import {
    closeSessionTab,
    moveSessionTab,
    normalizeSessionTabs,
    openSessionTab,
    pruneSessionTabs,
    stepSessionTab,
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

    test('stored values of the wrong shape become no tabs; the active tab must be one of them', () => {
        expect(normalizeSessionTabs(undefined)).toEqual({ ids: [], activeId: null })
        expect(normalizeSessionTabs('x')).toEqual({ ids: [], activeId: null })
        expect(normalizeSessionTabs({ ids: ['a', 3, '', 'b', 'a'], activeId: 'b' })).toEqual({ ids: ['a', 'b'], activeId: 'b' })
        expect(normalizeSessionTabs({ ids: ['a'], activeId: 'gone' })).toEqual({ ids: ['a'], activeId: null })
        expect(normalizeSessionTabs({ ids: 'a', activeId: 'a' })).toEqual({ ids: [], activeId: null })
    })

    test('prune keeps the same array when nothing went, so callers skip a write', () => {
        const ids = ['a', 'b']
        expect(pruneSessionTabs(ids, () => true)).toBe(ids)
        expect(pruneSessionTabs(ids, (id) => id !== 'a')).toEqual(['b'])
    })

    test('main storage: save, forget a closed session, prune at startup', () => {
        const store = fakeStore()
        const tabs = new SessionTabs(store)
        expect(tabs.get()).toEqual({ ids: [], activeId: null })

        tabs.set({ ids: ['a', 'b', 'c'], activeId: 'b', extra: 'dropped' })
        expect(store.data[SESSION_TABS_KEY]).toEqual({ ids: ['a', 'b', 'c'], activeId: 'b' })

        // Closing the active session also clears the tab to restore.
        tabs.forget('b')
        expect(tabs.get()).toEqual({ ids: ['a', 'c'], activeId: null })

        const before = store.writes()
        tabs.forget('not-a-tab')
        tabs.prune(new Set(['a', 'c']))
        expect(store.writes()).toBe(before)

        tabs.set({ ids: ['a', 'c'], activeId: 'c' })
        tabs.prune(new Set(['c']))
        expect(tabs.get()).toEqual({ ids: ['c'], activeId: 'c' })
    })
})
