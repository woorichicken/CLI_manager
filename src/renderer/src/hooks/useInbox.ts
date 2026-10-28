import { useMemo, useSyncExternalStore } from 'react'
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
