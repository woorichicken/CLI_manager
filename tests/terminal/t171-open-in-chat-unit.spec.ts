import { test, expect } from '@playwright/test'
import * as mod from '../../src/renderer/src/hooks/useSessionViewMode'

/**
 * T171 (unit) — `applyOpenInChat`: a session flagged `openInChat` is switched to Chat once. After the person put
 * it back on Terminal it stays there on the next call (a restart), unflagged sessions are never touched, and the
 * record of handled sessions drops the ones that are gone. A stand-in localStorage (no Electron).
 */

function installStorage(): Map<string, string> {
    const data = new Map<string, string>()
    ;(globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
        clear: () => data.clear(),
        key: () => null,
        length: 0
    } as Storage
    return data
}

test('T171 openInChat switches a flagged session once, never an unflagged one, and respects a later Terminal choice', async () => {
    installStorage()
    const sessions = [{ id: 'flagged' , openInChat: true }, { id: 'plain' }, { id: 'later', openInChat: true }]

    mod.applyOpenInChat(sessions.slice(0, 2))
    expect(mod.getSessionViewMode('flagged')).toBe('chat')
    expect(mod.getSessionViewMode('plain')).toBe('terminal')

    // the person goes back to the terminal; a restart applies again
    mod.setSessionViewMode('flagged', 'terminal')
    mod.applyOpenInChat(sessions.slice(0, 2))
    expect(mod.getSessionViewMode('flagged')).toBe('terminal')

    // a session that appears later is switched; the earlier choice is still kept
    mod.applyOpenInChat(sessions)
    expect(mod.getSessionViewMode('later')).toBe('chat')
    expect(mod.getSessionViewMode('flagged')).toBe('terminal')

    // a closed session leaves no record: the stored list holds only flagged sessions that still exist
    mod.applyOpenInChat([{ id: 'later', openInChat: true }])
    expect(JSON.parse(localStorage.getItem('session-open-in-applied') ?? '[]')).toEqual(['later'])
})
