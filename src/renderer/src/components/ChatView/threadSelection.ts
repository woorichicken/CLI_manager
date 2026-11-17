/**
 * Which thread panel is open in each parent's Chat view. A module store rather than view state:
 * it lasts until the app restarts, and the sidebar's Threads list opens a panel from outside the
 * view (the view may not even be mounted yet — it reads the store when it is).
 */
const openThreadBySession = new Map<string, string>()
type Listener = (childId: string | null) => void
const listeners = new Map<string, Set<Listener>>()

export function openThreadOf(parentId: string): string | null {
    return openThreadBySession.get(parentId) ?? null
}

export function setOpenThread(parentId: string, childId: string | null): void {
    if (childId === null) openThreadBySession.delete(parentId)
    else openThreadBySession.set(parentId, childId)
    for (const listener of listeners.get(parentId) ?? []) listener(childId)
}

/** A mounted Chat view follows panels opened from elsewhere. */
export function onOpenThreadChange(parentId: string, listener: Listener): () => void {
    let set = listeners.get(parentId)
    if (!set) {
        set = new Set()
        listeners.set(parentId, set)
    }
    set.add(listener)
    return () => {
        set!.delete(listener)
        if (set!.size === 0) listeners.delete(parentId)
    }
}
