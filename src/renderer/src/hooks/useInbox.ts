import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { InboxRequest } from '../../../shared/types'

/**
 * Inbox requests from main (InboxStore), kept current.
 *
 * One module-level store, like useControlApiMasters: every sidebar row reads it
 * for its dot, and a subscription per row would register one IPC listener per
 * session. Main sends the whole list on every change, so the latest one wins.
 */

const EMPTY: InboxRequest[] = []

let snapshot: InboxRequest[] = EMPTY
const listeners = new Set<() => void>()
let unsubscribeIpc: (() => void) | null = null

function publish(next: InboxRequest[]): void {
    snapshot = next
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (!unsubscribeIpc) {
        unsubscribeIpc = window.api.onInbox(publish)
        // Requests sent before this window (re)loaded were broadcast to nobody.
        window.api.getInbox().then(publish).catch(() => {})
    }
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && unsubscribeIpc) {
            unsubscribeIpc()
            unsubscribeIpc = null
        }
    }
}

/** Every request, newest first, read ones included. */
export function useInbox(): InboxRequest[] {
    return useSyncExternalStore(subscribe, () => snapshot)
}

/** Unread requests of one session, newest first. */
export function useUnreadInboxFor(sessionId: string): InboxRequest[] {
    const requests = useInbox()
    return useMemo(() => requests.filter((r) => !r.readAt && r.sessionId === sessionId), [requests, sessionId])
}

function useWindowFocused(): boolean {
    const [focused, setFocused] = useState(() => document.hasFocus())
    useEffect(() => {
        const onFocus = (): void => setFocused(true)
        const onBlur = (): void => setFocused(false)
        window.addEventListener('focus', onFocus)
        window.addEventListener('blur', onBlur)
        return () => {
            window.removeEventListener('focus', onFocus)
            window.removeEventListener('blur', onBlur)
        }
    }, [])
    return focused
}

/**
 * "Opening the session reads it": while this window has focus, the requests of
 * every session it shows (the active tab, each split pane, each Grid window
 * pane) are marked read — when the view changes, when a request arrives for a
 * session already on screen, and when the user comes back to the window. A
 * request from the session on screen while the user is in another app stays
 * unread (and on the Dock badge) until they return.
 */
export function useInboxReadOnView(visibleSessionIds: readonly string[]): void {
    const requests = useInbox()
    const focused = useWindowFocused()
    const key = visibleSessionIds.join(',')
    useEffect(() => {
        if (!focused || visibleSessionIds.length === 0) return
        const visible = new Set(visibleSessionIds)
        if (!requests.some((r) => !r.readAt && visible.has(r.sessionId))) return
        void window.api.markInboxSessionsRead([...visible])
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [requests, focused, key])
}
