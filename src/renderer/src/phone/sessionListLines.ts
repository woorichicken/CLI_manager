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
