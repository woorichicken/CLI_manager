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

/** How many levels the tree follows up and down; a longer chain is cut here. */
export const MAX_TREE_DEPTH = 6

export interface TreeEntry extends RelatedEntry {
    /** Levels away from the session: 1 is its parent / child, 2 the grandparent / grandchild. */
    depth: number
}

export interface SessionTree {
    /** Who opened this session, farthest first (the root of the chain on top). */
    ancestors: TreeEntry[]
    /** Sessions sharing a parent with this one. */
    siblings: TreeEntry[]
    /** What this session opened, children before their own children. */
    descendants: TreeEntry[]
    /** Added by hand: no direction, so no place in the tree. */
    manual: RelatedEntry[]
}

/**
 * The relations around `sessionId` as one tree. `from` is the parent for both
 * `opened` and `connected`; `manual` has no direction and is kept apart.
 *
 * A session shows once: `connected` can point both ways (A→B, B→C, C→A), so
 * the walk marks what it has placed. Below is placed first, then above, then
 * beside — in a ring the others land below. A closed session is not in
 * `workspaces`, which cuts the walk there, and what hung under it is lost.
 */
export function sessionTreeFor(relations: SessionRelation[], sessionId: string, workspaces: Workspace[]): SessionTree {
    const index = sessionIndex(workspaces)
    const tree: SessionTree = { ancestors: [], siblings: [], descendants: [], manual: [] }
    if (!index.has(sessionId)) return tree

    const children = new Map<string, SessionRelation[]>()
    const parents = new Map<string, SessionRelation[]>()
    for (const relation of relations) {
        if (relation.dismissed || relation.from === relation.to) continue
        if (!index.has(relation.from) || !index.has(relation.to)) continue
        if (relation.kind === 'manual') {
            if (relation.from !== sessionId && relation.to !== sessionId) continue
            const other = index.get(relation.from === sessionId ? relation.to : relation.from)!
            tree.manual.push({ ...other, kind: relation.kind, at: relation.at })
            continue
        }
        children.set(relation.from, [...(children.get(relation.from) ?? []), relation])
        parents.set(relation.to, [...(parents.get(relation.to) ?? []), relation])
    }
    tree.manual.sort((a, b) => b.at - a.at)

    const placed = new Set<string>([sessionId])
    const entryOf = (relation: SessionRelation, otherId: string, depth: number): TreeEntry => ({
        ...index.get(otherId)!,
        kind: relation.kind,
        at: relation.at,
        depth
    })
    const newestFirst = (a: SessionRelation, b: SessionRelation): number => b.at - a.at

    const walkDown = (id: string, depth: number): void => {
        if (depth > MAX_TREE_DEPTH) return
        for (const relation of [...(children.get(id) ?? [])].sort(newestFirst)) {
            if (placed.has(relation.to)) continue
            placed.add(relation.to)
            tree.descendants.push(entryOf(relation, relation.to, depth))
            walkDown(relation.to, depth + 1)
        }
    }
    walkDown(sessionId, 1)

    let level = [sessionId]
    for (let depth = 1; depth <= MAX_TREE_DEPTH && level.length > 0; depth++) {
        const next: string[] = []
        for (const id of level) {
            for (const relation of [...(parents.get(id) ?? [])].sort(newestFirst)) {
                if (placed.has(relation.from)) continue
                placed.add(relation.from)
                tree.ancestors.push(entryOf(relation, relation.from, depth))
                next.push(relation.from)
            }
        }
        level = next
    }
    tree.ancestors.sort((a, b) => b.depth - a.depth || b.at - a.at)

    for (const parent of tree.ancestors.filter(entry => entry.depth === 1)) {
        for (const relation of [...(children.get(parent.session.id) ?? [])].sort(newestFirst)) {
            if (placed.has(relation.to)) continue
            placed.add(relation.to)
            tree.siblings.push(entryOf(relation, relation.to, 1))
        }
    }
    return tree
}
