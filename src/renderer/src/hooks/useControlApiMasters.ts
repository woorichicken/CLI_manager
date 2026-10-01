import { useSyncExternalStore } from 'react'
import { ControlApiMasters } from '../../../shared/types'

/**
 * Orchestrator marks from the Control API (sessions that opened other sessions).
 *
 * One module-level store instead of state in App: every sidebar row reads it,
 * and a subscription per row would register one IPC listener per session.
 * Main sends the whole snapshot on every change, so the latest one wins.
 */

const EMPTY: ControlApiMasters = { masters: {}, openedBy: {} }

let snapshot: ControlApiMasters = EMPTY
const listeners = new Set<() => void>()
let unsubscribeIpc: (() => void) | null = null

function publish(next: ControlApiMasters): void {
    snapshot = next
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (!unsubscribeIpc) {
        unsubscribeIpc = window.api.onControlApiMasters(publish)
        // Marks set before this window (re)loaded were broadcast to nobody.
        window.api.getControlApiMasters().then(publish).catch(() => {})
    }
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && unsubscribeIpc) {
            unsubscribeIpc()
            unsubscribeIpc = null
        }
    }
}

export function useControlApiMasters(): ControlApiMasters {
    return useSyncExternalStore(subscribe, () => snapshot)
}
