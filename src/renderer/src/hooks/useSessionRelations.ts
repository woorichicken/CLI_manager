import { useSyncExternalStore } from 'react'
import { SessionRelation } from '../../../shared/types'

/**
 * Related-session records from main (SessionRelations), kept current.
 *
 * One module-level store, like useControlApiMasters: every header reads it,
 * and a subscription per header would register one IPC listener per pane.
 * Main sends the whole list on every change, so the latest one wins.
 */

const EMPTY: SessionRelation[] = []

let snapshot: SessionRelation[] = EMPTY
const listeners = new Set<() => void>()
let unsubscribeIpc: (() => void) | null = null

function publish(next: SessionRelation[]): void {
    snapshot = next
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (!unsubscribeIpc) {
        unsubscribeIpc = window.api.onSessionRelations(publish)
        // Relations saved before this window (re)loaded were broadcast to nobody.
        window.api.getSessionRelations().then(publish).catch(() => {})
    }
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && unsubscribeIpc) {
            unsubscribeIpc()
            unsubscribeIpc = null
        }
    }
}

export function useSessionRelations(): SessionRelation[] {
    return useSyncExternalStore(subscribe, () => snapshot)
}
