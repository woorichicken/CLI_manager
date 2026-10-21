import type { SessionRelation, SessionRelationKind, TerminalSession, Workspace } from '../../../shared/types'

/**
 * Related sessions: what the session header's dialog lists for one session.
 *
 * Main keeps the relations (SessionRelations); this turns them into the three
 * groups the dialog shows. Pure, so the grouping is tested without Electron.
 */

/**
 * A session an agent opened for the user to talk in (study, discussion) is
 * named like this. Agents leave it open until the user asks to close it, so the
 * dialog marks it to tell it apart from a worker.
 */
export const TALK_SESSION_PREFIX = '대화:'

export function isTalkSession(name: string): boolean {
    return name.trim().startsWith(TALK_SESSION_PREFIX)
}

export interface RelatedEntry {
    session: TerminalSession
    workspace: Workspace
    kind: SessionRelationKind
    /** When it was recorded (epoch ms). */
    at: number
}

export interface RelatedGroups {
    /** Sessions this one opened, or first worked in, through the Control API. */
    fromHere: RelatedEntry[]
    /** Sessions that opened this one, or first worked in it. */
    toHere: RelatedEntry[]
    /** Added by hand, from either side. */
    manual: RelatedEntry[]
    total: number
}

function sessionIndex(workspaces: Workspace[]): Map<string, { session: TerminalSession; workspace: Workspace }> {
    const index = new Map<string, { session: TerminalSession; workspace: Workspace }>()
    for (const workspace of workspaces) {
        for (const session of workspace.sessions ?? []) index.set(session.id, { session, workspace })
    }
    return index
}

/**
 * The related sessions of `sessionId`, grouped, newest first. A relation whose
 * other side is no longer in `workspaces` is left out — a closed session
 * disappears here at once, before main's cleanup reaches the renderer.
 */
export function relatedSessionsFor(
    relations: SessionRelation[],
    sessionId: string,
    workspaces: Workspace[]
): RelatedGroups {
    const index = sessionIndex(workspaces)
    const groups: RelatedGroups = { fromHere: [], toHere: [], manual: [], total: 0 }
    if (!index.has(sessionId)) return groups

    for (const relation of relations) {
        if (relation.dismissed) continue
        const outgoing = relation.from === sessionId
        if (!outgoing && relation.to !== sessionId) continue
        const other = index.get(outgoing ? relation.to : relation.from)
        if (!other || other.session.id === sessionId) continue

        const entry: RelatedEntry = { ...other, kind: relation.kind, at: relation.at }
        if (relation.kind === 'manual') groups.manual.push(entry)
        else if (outgoing) groups.fromHere.push(entry)
        else groups.toHere.push(entry)
    }

    const newestFirst = (a: RelatedEntry, b: RelatedEntry): number => b.at - a.at
    groups.fromHere.sort(newestFirst)
    groups.toHere.sort(newestFirst)
    groups.manual.sort(newestFirst)
    groups.total = groups.fromHere.length + groups.toHere.length + groups.manual.length
    return groups
}

/** How many related sessions each session has, for the header buttons. */
export function relatedCounts(relations: SessionRelation[], workspaces: Workspace[]): Map<string, number> {
    const index = sessionIndex(workspaces)
    const counts = new Map<string, number>()
    const bump = (id: string): void => {
        counts.set(id, (counts.get(id) ?? 0) + 1)
    }
    for (const relation of relations) {
        if (relation.dismissed || relation.from === relation.to) continue
        if (!index.has(relation.from) || !index.has(relation.to)) continue
        bump(relation.from)
        bump(relation.to)
    }
    return counts
}

/**
 * Sessions that can still be added to `sessionId`'s list, filtered by a
 * case-insensitive match on the session or workspace name.
 */
export function addableSessions(
    workspaces: Workspace[],
    sessionId: string,
    relatedIds: Set<string>,
    query: string
): Array<{ session: TerminalSession; workspace: Workspace }> {
    const needle = query.trim().toLowerCase()
    return workspaces.flatMap(workspace =>
        (workspace.sessions ?? [])
            .filter(session => session.id !== sessionId && !relatedIds.has(session.id))
            .filter(session =>
                !needle ||
                session.name.toLowerCase().includes(needle) ||
                workspace.name.toLowerCase().includes(needle)
            )
            .map(session => ({ session, workspace }))
    )
}
