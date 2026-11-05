import type { PhoneSession, PhoneSessionsResponse } from '../../../shared/phone'

/**
 * The phone's session list as lines to draw: the rows exactly in the order main sent them
 * (the Mac's All sessions List), with the Mac's own marks between them — a heading where a
 * session folder's sessions start (and "No folder" before the rest, once folders exist) and
 * one line under the pinned sessions of each part, as the sidebar's `dividePinned` draws it.
 */

export type ListLine =
    | { kind: 'folder'; key: string; title: string; folderId: string | null }
    | { kind: 'divider'; key: string }
    | { kind: 'row'; key: string; session: PhoneSession }

/** The rows with the Mac's folder headings and pinned lines between them; the order is untouched. */
export function listLines(data: PhoneSessionsResponse): ListLine[] {
    const folderName = new Map(data.sessionFolders.map((folder) => [folder.id, folder.name]))
    const lines: ListLine[] = []
    let part: string | null | undefined
    let pinnedInPart = false
    for (const session of data.sessions) {
        const folderId = session.sessionFolderId && folderName.has(session.sessionFolderId) ? session.sessionFolderId : null
        if (folderId !== part) {
            part = folderId
            pinnedInPart = false
            // the Mac shows folder headings only once there are session folders; "No folder" then heads the rest
            if (data.sessionFolders.length > 0) {
                lines.push({ kind: 'folder', key: `folder-${folderId ?? 'none'}`, title: folderId ? folderName.get(folderId)! : 'No folder', folderId })
            }
        }
        if (session.pinned) pinnedInPart = true
        else if (pinnedInPart) {
            // as the Mac's dividePinned: one line between the pinned sessions and the rest of a part
            lines.push({ kind: 'divider', key: `divider-${folderId ?? 'none'}` })
            pinnedInPart = false
        }
        lines.push({ kind: 'row', key: session.id, session })
    }
    return lines
}

/**
 * The rows a search finds (1b92a570): every word of `query` in the session's name, its workspace's name
 * or its session folder's name, ignoring case. Flat — the headings would only split a short result —
 * and still in the Mac's order. An empty query is no search: null.
 */
export function searchLines(data: PhoneSessionsResponse, query: string): ListLine[] | null {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    if (words.length === 0) return null
    const folderName = new Map(data.sessionFolders.map((folder) => [folder.id, folder.name]))
    return data.sessions
        .filter((session) => {
            const haystack = [session.name, session.workspaceName, session.sessionFolderId ? folderName.get(session.sessionFolderId) ?? '' : '']
                .join('\n')
                .toLowerCase()
            return words.every((word) => haystack.includes(word))
        })
        .map((session) => ({ kind: 'row', key: session.id, session }))
}
