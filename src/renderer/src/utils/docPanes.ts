import { MAX_LINKED_SESSIONS } from './sessionLink'

/**
 * A document pane in split view (backlog 「앱 안 브라우저」 B). The split's list (`SplitTerminalLayout.sessionIds`) holds
 * one id per pane; a document's id starts with `doc:` so it takes a place in the grid like a session, and every place
 * that looks a session up by id simply finds none. Document panes are not kept: the split is not saved either.
 */
export const DOC_PANE_PREFIX = 'doc:'

export const isDocPaneId = (id: string): boolean => id.startsWith(DOC_PANE_PREFIX)

/** The panes that are sessions: what the grid window, the recent list and the Related dialog may see. */
export const sessionPaneIds = (ids: readonly string[]): string[] => ids.filter((id) => !isDocPaneId(id))

export interface DocPane {
    path: string
    line?: number
    /** showing the page's source instead of the drawn page */
    source: boolean
}

/** Why a document cannot be put beside: the split holds MAX_LINKED_SESSIONS panes. */
export function docSideBlockedReason(currentIds: readonly string[] | null): string | null {
    return currentIds && currentIds.length >= MAX_LINKED_SESSIONS
        ? `Split view holds ${MAX_LINKED_SESSIONS} panes — close one to put this beside`
        : null
}

export type DocBesideResult =
    | { kind: 'full' }
    | { kind: 'layout'; sessionIds: string[]; activeIndex: number }

/**
 * The split after putting a document beside. In split view it takes the next place; otherwise it opens a split of the
 * session on screen and the document. The session stays the active pane: the person was reading from its Chat.
 */
export function splitWithDoc(currentIds: readonly string[] | null, activeIndex: number, activeSessionId: string | null, docId: string): DocBesideResult {
    if (currentIds && currentIds.length > 0) {
        if (docSideBlockedReason(currentIds)) return { kind: 'full' }
        return { kind: 'layout', sessionIds: [...currentIds, docId], activeIndex: Math.min(activeIndex, currentIds.length - 1) }
    }
    return { kind: 'layout', sessionIds: activeSessionId ? [activeSessionId, docId] : [docId], activeIndex: 0 }
}

export type SplitRemoveResult =
    | { kind: 'single'; sessionId: string }
    | { kind: 'layout'; sessionIds: string[]; activeIndex: number }
    | { kind: 'none' }

/**
 * The split after closing one pane. One session left: the single view of it (as before). A document left alone stays
 * on screen as a one-pane split. Nothing left: back to `fallbackSessionId` (the session the document was put beside),
 * when there is one.
 */
export function splitAfterRemove(currentIds: readonly string[], activeIndex: number, removedId: string, fallbackSessionId: string | null): SplitRemoveResult {
    const removedIndex = currentIds.indexOf(removedId)
    const sessionIds = currentIds.filter((id) => id !== removedId)
    if (sessionIds.length === 0) return fallbackSessionId ? { kind: 'single', sessionId: fallbackSessionId } : { kind: 'none' }
    if (sessionIds.length === 1 && !isDocPaneId(sessionIds[0])) return { kind: 'single', sessionId: sessionIds[0] }
    let nextActive = activeIndex
    if (nextActive >= sessionIds.length) nextActive = sessionIds.length - 1
    else if (removedIndex >= 0 && removedIndex <= activeIndex && activeIndex > 0) nextActive = activeIndex - 1
    return { kind: 'layout', sessionIds, activeIndex: nextActive }
}
