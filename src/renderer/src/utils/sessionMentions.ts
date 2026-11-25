import type { SessionMention } from '../../../shared/conversation'
import type { SessionRelation, Workspace } from '../../../shared/types'
import { sessionTreeFor, threadSessionIds, type RelatedEntry } from './relatedSessions'

/** How many sessions the `@` menu lists: the files below it keep their room. */
export const MAX_SESSION_MENTIONS = 8

/** What the transport knows about the app's sessions; App keeps it current. */
export interface SessionCatalog {
    workspaces: Workspace[]
    relations: SessionRelation[]
}

let catalog: SessionCatalog = { workspaces: [], relations: [] }
export function setSessionCatalog(next: SessionCatalog): void {
    catalog = next
}
export function getSessionCatalog(): SessionCatalog {
    return catalog
}

/**
 * The sessions the `@` menu offers for `sessionId` (89755e23). Order: what this session opened (Below, in
 * the Related window's tree order) → Beside → Above → Also related → every other session, the ones looked
 * at most recently first (`viewedIds`). The session itself and answer threads are left out (the sidebar
 * hides threads too). `query`: every word must be in the session's or its workspace's name, any case.
 */
export function sessionMentionsFor(input: {
    relations: SessionRelation[]
    sessionId: string
    workspaces: Workspace[]
    viewedIds?: string[]
    query?: string
    limit?: number
}): SessionMention[] {
    const { relations, sessionId, workspaces, viewedIds = [], query = '', limit = MAX_SESSION_MENTIONS } = input
    const threads = threadSessionIds(relations)
    const tree = sessionTreeFor(relations, sessionId, workspaces)
    const rows: SessionMention[] = []
    const placed = new Set<string>([sessionId, ...threads])
    const add = (entries: RelatedEntry[], relation: SessionMention['relation']): void => {
        for (const entry of entries) {
            if (placed.has(entry.session.id)) continue
            placed.add(entry.session.id)
            rows.push({ id: entry.session.id, name: entry.session.name, workspace: entry.workspace.name, ...(relation ? { relation } : {}) })
        }
    }
    add(tree.descendants, 'below')
    add(tree.siblings, 'beside')
    add(tree.ancestors, 'above')
    add(tree.other, 'also')

    const all = workspaces.flatMap((workspace) => (workspace.sessions ?? []).map((session) => ({ session, workspace })))
    const byId = new Map(all.map((entry) => [entry.session.id, entry]))
    const rest = [...viewedIds.map((id) => byId.get(id)), ...all].filter((entry): entry is (typeof all)[number] => entry !== undefined)
    add(rest.map((entry) => ({ ...entry, kind: 'manual' as const, at: 0 })), undefined)

    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return rows
        .filter((row) => {
            const haystack = `${row.name} ${row.workspace}`.toLowerCase()
            return words.every((word) => haystack.includes(word))
        })
        .slice(0, limit)
}

/** What a picked session turns into in the box: its name and a session link the message keeps. */
export function sessionMentionText(mention: Pick<SessionMention, 'id' | 'name'>): string {
    return `${mention.name} (climanager://session/${mention.id.slice(0, 8)})`
}
