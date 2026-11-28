import type { PhoneSession, PhoneSessionsResponse } from '../../../shared/phone'
import { sessionIdQuery } from '../utils/sessionLink'

/**
 * The phone's session list as lines to draw: the rows exactly in the order main sent them
 * (the Mac's All sessions List), with the Mac's own marks between them — a heading where a
 * session folder's sessions start (and "No folder" before the rest, once folders exist) and
 * one line under the pinned sessions of each part, as the sidebar's `dividePinned` draws it.
 */

export type ListLine =
    | {
          kind: 'folder'
          key: string
          title: string
          folderId: string | null
          /** List only: a heading a tap folds (b61af757) — «Not in a tree» is a plain label */
          collapsible?: boolean
          /** how many sessions the part holds, whether or not they are shown */
          count?: number
          collapsed?: boolean
      }
    | { kind: 'divider'; key: string }
    | { kind: 'row'; key: string; session: PhoneSession; /** Tree only: levels under its root (0 = a root) */ depth?: number }

/** The sessions the list shows: all but reply threads (1b965ad1). */
export function listedSessions(data: PhoneSessionsResponse): PhoneSession[] {
    return data.sessions.filter((session) => !session.thread)
}

/** What a folded part is called in the saved list: a session folder's id, or this for «No folder». */
export const NO_FOLDER_PART = 'none'

/**
 * The rows with the Mac's folder headings and pinned lines between them; the order is untouched.
 * `collapsed` names the parts folded shut (b61af757, as the Mac sidebar's cbc0ee48): their heading stays
 * with its count, their rows and pinned line do not.
 */
export function listLines(data: PhoneSessionsResponse, collapsed: ReadonlySet<string> = new Set()): ListLine[] {
    const folderName = new Map(data.sessionFolders.map((folder) => [folder.id, folder.name]))
    const lines: ListLine[] = []
    let part: string | null | undefined
    let pinnedInPart = false
    let heading: (ListLine & { kind: 'folder' }) | null = null
    for (const session of data.sessions) {
        // a reply's thread is not a row, as in the Mac sidebar (1b965ad1); search still finds it
        if (session.thread) continue
        const folderId = session.sessionFolderId && folderName.has(session.sessionFolderId) ? session.sessionFolderId : null
        if (folderId !== part) {
            part = folderId
            pinnedInPart = false
            // the Mac shows folder headings only once there are session folders; "No folder" then heads the rest
            heading = null
            if (data.sessionFolders.length > 0) {
                heading = {
                    kind: 'folder',
                    key: `folder-${folderId ?? 'none'}`,
                    title: folderId ? folderName.get(folderId)! : 'No folder',
                    folderId,
                    collapsible: true,
                    count: 0,
                    collapsed: collapsed.has(folderId ?? NO_FOLDER_PART)
                }
                lines.push(heading)
            }
        }
        if (heading) heading.count = (heading.count ?? 0) + 1
        if (heading?.collapsed) continue
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
 * The Mac's All sessions Tree (7c4165af) as lines: main sends the forest the sidebar draws
 * (`sessionForestFor`), so this only looks each id up — each row under its parent at its depth, then
 * «Not in a tree» and the rest, as the sidebar's SidebarSessionTree. A session gone since is skipped.
 * No tree in the response (the Mac's «Show Session Tree» off): null.
 */
export function treeLines(data: PhoneSessionsResponse): ListLine[] | null {
    if (!data.tree) return null
    const byId = new Map(data.sessions.map((session) => [session.id, session]))
    const lines: ListLine[] = []
    for (const { id, depth } of data.tree.rows) {
        const session = byId.get(id)
        if (session && !session.thread) lines.push({ kind: 'row', key: id, session, depth })
    }
    const unlinked = data.tree.unlinked.flatMap((id) => (byId.has(id) && !byId.get(id)!.thread ? [byId.get(id)!] : []))
    if (unlinked.length > 0 && lines.length > 0) lines.push({ kind: 'folder', key: 'tree-unlinked', title: 'Not in a tree', folderId: null })
    for (const session of unlinked) lines.push({ kind: 'row', key: session.id, session, depth: 0 })
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
    // The start of a session id, or a pasted session link, finds that session too (a74575ea — the sidebar's rule).
    const idPrefix = sessionIdQuery(query)
    return data.sessions
        .filter((session) => {
            const haystack = [session.name, session.workspaceName, session.sessionFolderId ? folderName.get(session.sessionFolderId) ?? '' : '']
                .join('\n')
                .toLowerCase()
            return words.every((word) => haystack.includes(word)) || (idPrefix !== null && session.id.toLowerCase().startsWith(idPrefix))
        })
        .map((session) => ({ kind: 'row', key: session.id, session }))
}
