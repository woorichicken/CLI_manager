import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { Checklist } from '../../../shared/types'

/**
 * Header checklists from main (ChecklistStore), kept current — the same module-level
 * store as useInbox. Main sends the whole list, in header order, on every change
 * (panel or Control API), so the latest one wins.
 */

const EMPTY: Checklist[] = []

let snapshot: Checklist[] = EMPTY
const listeners = new Set<() => void>()
let unsubscribeIpc: (() => void) | null = null

function publish(next: Checklist[]): void {
    snapshot = next
    for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    if (!unsubscribeIpc) {
        unsubscribeIpc = window.api.onChecklists(publish)
        // Checklists made before this window (re)loaded were broadcast to nobody.
        window.api.getChecklists().then(publish).catch(() => {})
    }
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && unsubscribeIpc) {
            unsubscribeIpc()
            unsubscribeIpc = null
        }
    }
}

/** Every checklist: open ones by nearest deadline, then finished ones. */
export function useChecklists(): Checklist[] {
    return useSyncExternalStore(subscribe, () => snapshot)
}

/** The header shows the checklist looked at last; switching sessions does not change it. */
const LAST_VIEWED_KEY = 'checklists-last-viewed'

function readLastViewed(): string | null {
    try {
        return localStorage.getItem(LAST_VIEWED_KEY)
    } catch {
        return null
    }
}

function writeLastViewed(id: string): void {
    try {
        localStorage.setItem(LAST_VIEWED_KEY, id)
    } catch {
        // Private storage off: the header falls back to the first checklist.
    }
}

export interface CurrentChecklist {
    checklists: Checklist[]
    current: Checklist | null
    /** Position of `current` from 0, -1 when there is none. */
    index: number
    /** One step through the header order, wrapping at both ends. */
    page: (delta: 1 | -1) => void
    select: (id: string) => void
}

/**
 * Which checklist the header shows: the one looked at last, or the first in header order
 * when that one is gone (removed, or never picked).
 */
export function useCurrentChecklist(): CurrentChecklist {
    const checklists = useChecklists()
    const [lastViewed, setLastViewed] = useState<string | null>(readLastViewed)
    const found = checklists.findIndex((c) => c.id === lastViewed)
    const index = found >= 0 ? found : checklists.length > 0 ? 0 : -1

    const select = useCallback((id: string) => {
        setLastViewed(id)
        writeLastViewed(id)
    }, [])

    // What the header shows is what was looked at: without this, a new checklist with an earlier
    // deadline would take the header over before the user ever picked one.
    const shownId = index >= 0 ? checklists[index].id : null
    useEffect(() => {
        if (shownId && shownId !== lastViewed) select(shownId)
    }, [shownId, lastViewed, select])

    const page = useCallback(
        (delta: 1 | -1) => {
            if (checklists.length === 0) return
            const next = (Math.max(index, 0) + delta + checklists.length) % checklists.length
            select(checklists[next].id)
        },
        [checklists, index, select]
    )

    return { checklists, current: index >= 0 ? checklists[index] : null, index, page, select }
}
