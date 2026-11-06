import { useSyncExternalStore } from 'react'

/**
 * This phone's own chat settings (b6b1b6b6 · 69340cc2 · 847da0aa), kept in the phone's browser:
 * two phones of one Mac may want different keys.
 */
export interface PhoneChatSettings {
    /** Return sends; off, Return breaks the line and the arrow sends. Off by default (Q-3). */
    returnSends: boolean
    /** one-tap phrases over the empty box, or null: not chosen here — on when the Mac has phrases of its own */
    quickReplies: boolean | null
    /** my last message stays on top of the chat, or null: not chosen here — what the Mac is set to */
    pinLastMessage: boolean | null
    /** the droplet and ☰'s number when another session needs you. On by default; the dots stay either way. */
    alerts: boolean
}

const KEY = 'phone-chat-settings'
const listeners = new Set<() => void>()
const choice = (value: unknown): boolean | null => (typeof value === 'boolean' ? value : null)
let current: PhoneChatSettings = read()

function read(): PhoneChatSettings {
    try {
        const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
        return {
            returnSends: parsed.returnSends === true,
            // v1.26 saved `quickReplies: false` for anyone who only touched the other switch: only its true was a choice
            quickReplies: choice(parsed.quickRepliesChoice) ?? (parsed.quickReplies === true ? true : null),
            pinLastMessage: choice(parsed.pinLastMessage),
            alerts: parsed.alerts !== false
        }
    } catch {
        return { returnSends: false, quickReplies: null, pinLastMessage: null, alerts: true }
    }
}

export function setPhoneChatSetting<K extends keyof PhoneChatSettings>(key: K, value: PhoneChatSettings[K]): void {
    current = { ...current, [key]: value }
    try {
        const { quickReplies, ...rest } = current
        localStorage.setItem(KEY, JSON.stringify({ ...rest, quickRepliesChoice: quickReplies }))
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
