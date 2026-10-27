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

/** How the Relations tab orders the sessions on one level of the tree. */
export type RelatedOrder = 'newest' | 'oldest' | 'name' | 'viewed'

export const RELATED_ORDERS: Array<{ key: RelatedOrder; label: string }> = [
    { key: 'newest', label: 'Newest first' },
    { key: 'oldest', label: 'Oldest first' },
    { key: 'name', label: 'Name' },
    { key: 'viewed', label: 'Recently viewed' }
]

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
export function sessionTreeFor(
    relations: SessionRelation[],
    sessionId: string,
    workspaces: Workspace[],
    order: RelatedOrder = 'newest',
    /** Session ids the user looked at, newest first — for the 'viewed' order. */
    viewedIds: string[] = []
): SessionTree {
    const index = sessionIndex(workspaces)
    const viewedRank = new Map(viewedIds.map((id, rank) => [id, rank]))
    // Only the order within one level changes: a child stays under its parent.
    const compare = (aId: string, aAt: number, bId: string, bAt: number): number => {
        if (order === 'oldest') return aAt - bAt
        if (order === 'name') {
            const byName = index.get(aId)!.session.name.localeCompare(index.get(bId)!.session.name, undefined, { numeric: true })
            if (byName !== 0) return byName
        }
        if (order === 'viewed') {
            const aRank = viewedRank.get(aId) ?? Number.MAX_SAFE_INTEGER
            const bRank = viewedRank.get(bId) ?? Number.MAX_SAFE_INTEGER
            if (aRank !== bRank) return aRank - bRank
        }
        return bAt - aAt
    }
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
    tree.manual.sort((a, b) => compare(a.session.id, a.at, b.session.id, b.at))

    const placed = new Set<string>([sessionId])
    const entryOf = (relation: SessionRelation, otherId: string, depth: number): TreeEntry => ({
        ...index.get(otherId)!,
        kind: relation.kind,
        at: relation.at,
        depth
    })
    const childOrder = (a: SessionRelation, b: SessionRelation): number => compare(a.to, a.at, b.to, b.at)
    const parentOrder = (a: SessionRelation, b: SessionRelation): number => compare(a.from, a.at, b.from, b.at)

    const walkDown = (id: string, depth: number): void => {
        if (depth > MAX_TREE_DEPTH) return
        for (const relation of [...(children.get(id) ?? [])].sort(childOrder)) {
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
            for (const relation of [...(parents.get(id) ?? [])].sort(parentOrder)) {
                if (placed.has(relation.from)) continue
                placed.add(relation.from)
                tree.ancestors.push(entryOf(relation, relation.from, depth))
                next.push(relation.from)
            }
        }
        level = next
    }
    tree.ancestors.sort((a, b) => b.depth - a.depth || compare(a.session.id, a.at, b.session.id, b.at))

    for (const parent of tree.ancestors.filter(entry => entry.depth === 1)) {
        for (const relation of [...(children.get(parent.session.id) ?? [])].sort(childOrder)) {
            if (placed.has(relation.to)) continue
            placed.add(relation.to)
            tree.siblings.push(entryOf(relation, relation.to, 1))
        }
    }
    return tree
}

/**
 * The sessions that opened `sessionId`, or first worked in it — its parents in
 * the tree, newest first. Hand-added pairs have no direction and are left out.
 */
export function parentSessionsOf(relations: SessionRelation[], sessionId: string, workspaces: Workspace[]): RelatedEntry[] {
    const index = sessionIndex(workspaces)
    const parents = new Map<string, RelatedEntry>()
    for (const relation of relations) {
        if (relation.dismissed || relation.kind === 'manual' || relation.to !== sessionId || relation.from === sessionId) continue
        const parent = index.get(relation.from)
        if (!parent) continue
        const known = parents.get(relation.from)
        if (!known || known.at < relation.at) parents.set(relation.from, { ...parent, kind: relation.kind, at: relation.at })
    }
    return [...parents.values()].sort((a, b) => b.at - a.at)
}

export interface ForestRow {
    session: TerminalSession
    workspace: Workspace
    /** 0 for a root; 1 for what it opened, and so on. */
    depth: number
}

export interface SessionForest {
    /** Every tree, root first and each session under the one that opened it. */
    rows: ForestRow[]
    /** Sessions with no parent or child: no relation, or only hand-added ones (they have no direction). */
    unlinked: Array<{ session: TerminalSession; workspace: Workspace }>
}

/**
 * Every listed session as trees, for the sidebar's All sessions view. Each tree
 * is `sessionTreeFor` of its root, so the rules are the Related dialog's: the
 * same parents, the depth limit, removed pairs left out, manual pairs not in it.
 *
 * Roots are taken in list order. A session shows once: met again under a later
 * root, it is skipped with what hangs under it there. What no root reaches — a
 * ring has no root, the depth limit cuts a long chain — starts a tree of its own.
 */
export function sessionForestFor(
    relations: SessionRelation[],
    entries: Array<{ session: TerminalSession; workspace: Workspace }>,
    /** Session ids the user looked at, newest first: orders each level like the list. */
    viewedIds: string[] = []
): SessionForest {
    const listed = new Map(entries.map(entry => [entry.session.id, entry]))
    // The tree sees only listed sessions: a hidden worktree's session must not appear in it.
    const visible = new Map<string, Workspace>()
    for (const { workspace, session } of entries) {
        const holder = visible.get(workspace.id) ?? { ...workspace, sessions: [] }
        holder.sessions = [...holder.sessions, session]
        visible.set(workspace.id, holder)
    }
    const workspaces = [...visible.values()]

    const linked = new Set<string>()
    const hasParent = new Set<string>()
    for (const relation of relations) {
        if (relation.dismissed || relation.kind === 'manual' || relation.from === relation.to) continue
        if (!listed.has(relation.from) || !listed.has(relation.to)) continue
        linked.add(relation.from)
        linked.add(relation.to)
        hasParent.add(relation.to)
    }

    const rows: ForestRow[] = []
    const placed = new Set<string>()
    const plant = (rootId: string): void => {
        placed.add(rootId)
        rows.push({ ...listed.get(rootId)!, depth: 0 })
        let skipBelow = Number.POSITIVE_INFINITY
        for (const entry of sessionTreeFor(relations, rootId, workspaces, 'viewed', viewedIds).descendants) {
            if (entry.depth > skipBelow) continue
            skipBelow = Number.POSITIVE_INFINITY
            if (placed.has(entry.session.id)) {
                skipBelow = entry.depth
                continue
            }
            placed.add(entry.session.id)
            rows.push({ ...listed.get(entry.session.id)!, depth: entry.depth })
        }
    }
    for (const { session } of entries) {
        if (linked.has(session.id) && !hasParent.has(session.id) && !placed.has(session.id)) plant(session.id)
    }
    for (const { session } of entries) {
        if (linked.has(session.id) && !placed.has(session.id)) plant(session.id)
    }
    return { rows, unlinked: entries.filter(entry => !placed.has(entry.session.id)) }
}
