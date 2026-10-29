import { useSyncExternalStore } from 'react'
import { SessionScreenStatus, SessionScreenStatusMessage } from '../../../shared/types'

/**
 * Sidebar status dots judged in main from each screen (Settings > General
 * "Show Session Status"). Main sends only the sessions whose dot changed.
 *
 * A module-level store rather than state in App: a status change re-renders
 * the one row it belongs to, not the App and every sidebar row with it.
 * Each row selects its own entry, and unchanged entries keep their identity.
 */

/** What a row reads: `enabled` false means the setting is off and the row falls back to its old badge rules. */
export interface RowScreenStatus {
    enabled: boolean
    status: SessionScreenStatus | null
}

const DISABLED: RowScreenStatus = { enabled: false, status: null }
const IDLE: RowScreenStatus = { enabled: true, status: null }

let enabled = false
const rows = new Map<string, RowScreenStatus>()
const listeners = new Set<() => void>()
let unsubscribeIpc: (() => void) | null = null

function apply(message: SessionScreenStatusMessage): void {
    enabled = message.enabled
    if (message.reset) rows.clear()
    for (const change of message.changes) {
        if (change.state === 'idle') rows.delete(change.sessionId)
        else rows.set(change.sessionId, { enabled: true, status: change })
    }
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (!unsubscribeIpc) {
        unsubscribeIpc = window.api.onSessionScreenStatus(apply)
        // Dots shown before this window (re)loaded were sent to nobody.
        window.api.getSessionScreenStatuses().then(apply).catch(() => {})
    }
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && unsubscribeIpc) {
            unsubscribeIpc()
            unsubscribeIpc = null
        }
    }
}

export function useSessionScreenStatus(sessionId: string): RowScreenStatus {
    return useSyncExternalStore(subscribe, () => (enabled ? rows.get(sessionId) ?? IDLE : DISABLED))
}
