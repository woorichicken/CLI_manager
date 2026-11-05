import { useSyncExternalStore } from 'react'

/**
 * This phone's own chat settings (b6b1b6b6 · 69340cc2 · 847da0aa), kept in the phone's browser:
 * two phones of one Mac may want different keys. Both off by default — Return breaks the line on a
 * touch keyboard (Q-3), and the reply chips take a row the phone has little of.
 */
export interface PhoneChatSettings {
    /** Return sends; off, Return breaks the line and the arrow sends */
    returnSends: boolean
    /** one-tap phrases over the empty box — the Mac's list (Settings › Terminal › Chat view) */
    quickReplies: boolean
}

const KEY = 'phone-chat-settings'
const DEFAULTS: PhoneChatSettings = { returnSends: false, quickReplies: false }
const listeners = new Set<() => void>()
let current: PhoneChatSettings = read()

function read(): PhoneChatSettings {
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<PhoneChatSettings>
        return { returnSends: parsed.returnSends === true, quickReplies: parsed.quickReplies === true }
    } catch {
        return { ...DEFAULTS }
    }
}

export function setPhoneChatSetting<K extends keyof PhoneChatSettings>(key: K, value: PhoneChatSettings[K]): void {
    current = { ...current, [key]: value }
    try {
        localStorage.setItem(KEY, JSON.stringify(current))
    } catch {
        // not kept past this page; it still applies now
    }
    for (const listener of listeners) listener()
}

export function usePhoneChatSettings(): PhoneChatSettings {
    return useSyncExternalStore(
        (listener) => {
            listeners.add(listener)
            return () => listeners.delete(listener)
        },
        () => current
    )
}
