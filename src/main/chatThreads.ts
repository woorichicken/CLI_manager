import type { ChatThread, ChatThreadEntry } from '../shared/conversation'
import type { SessionRelation } from '../shared/types'

interface ThreadSession {
    id: string
    name: string
    /** the workspace the session sits in; only the Threads list shows it */
    workspaceName?: string
}

/** A Threads list row before main adds the quote, which reads the parent's transcript. */
export type ChatThreadListRow = Omit<ChatThreadEntry, 'quote'>

interface ThreadScreen {
    hasExited(id: string): boolean
    screenStatus(id: string): { busy: boolean; question: string | null }
    lastOutputAt(id: string): number
    /** The child's turns since the fork (`ReplyCounter`); undefined when not known. Absent: no counts. */
    replies?(childId: string, forkedAt: number, lastOutputAt: number): number | undefined
}

/** After a child's last output, its transcript is read again for this long: the record lands just after the screen. */
export const REPLY_SETTLE_MS = 5_000
const REPLY_CACHE_MAX = 500

/**
 * Each thread's reply count (fb-1117 2c8bc2b5): the child's turns written since the fork, as the
 * thread panel shows them. The child's transcript is read only when its output time moved, and for
 * REPLY_SETTLE_MS after that (the record is written just after the screen) — a quiet child is never
 * read again, so a tick over idle threads costs no transcript reads.
 */
export class ReplyCounter {
    private readonly cache = new Map<string, { at: number; forkedAt: number; count: number | undefined }>()

    constructor(
        private readonly read: (childId: string, forkedAt: number) => number | undefined,
        private readonly now: () => number = Date.now
    ) {}

    count(childId: string, forkedAt: number, lastOutputAt: number): number | undefined {
        const cached = this.cache.get(childId)
        const settling = lastOutputAt > 0 && this.now() - lastOutputAt < REPLY_SETTLE_MS
        if (cached && cached.at === lastOutputAt && cached.forkedAt === forkedAt && !settling) return cached.count
        const count = this.read(childId, forkedAt)
        if (this.cache.size >= REPLY_CACHE_MAX && !this.cache.has(childId)) this.cache.clear()
        this.cache.set(childId, { at: lastOutputAt, forkedAt, count })
        return count
    }

    forget(childId: string): void {
        this.cache.delete(childId)
    }
}

const ACTIVITY_BUCKET_MS = 30_000

/** Updated from the relation change callback, so a chat without forks needs no polling I/O. */
export function chatThreadParentIds(relations: SessionRelation[]): Set<string> {
    return new Set(relations.filter((relation) => !relation.dismissed && relation.kind === 'opened' && relation.anchor).map((relation) => relation.from))
}

interface ThreadSources {
    relations(): SessionRelation[]
    sessions(): ThreadSession[]
    screen: ThreadScreen
}

/** Output advances the relative-time chip only once per bucket; other fields remain exact. */
export function chatThreadSnapshot(threads: ChatThread[]): string {
    return JSON.stringify(threads.map((thread) => ({
        ...thread,
        lastActivityAt: Math.floor(thread.lastActivityAt / ACTIVITY_BUCKET_MS)
    })).sort((a, b) => a.childId.localeCompare(b.childId)))
}

/**
 * One tick shares its reads across parents; inactive parents still publish an emptied list.
 * `all` is the sidebar's Threads list: while one is open the tick also compares every anchored
 * parent's threads as one list. Without it the tick reads exactly what it read before the list existed.
 */
export function pollChatThreadChanges(
    parents: ReadonlySet<string>,
    anchoredParents: ReadonlySet<string>,
    previous: ReadonlyMap<string, string>,
    sources: ThreadSources,
    all?: { previous: string | null }
): { snapshots: Map<string, string>; changed: string[]; all?: { snapshot: string; changed: boolean } } {
    const hasThreads = (all !== undefined && anchoredParents.size > 0) || [...parents].some((id) => anchoredParents.has(id))
    const relations = hasThreads ? sources.relations() : []
    const sessions = hasThreads ? sources.sessions() : []
    const snapshots = new Map<string, string>()
    const changed: string[] = []
    const byParent = new Map<string, ChatThread[]>()
    const threadsOf = (parentId: string): ChatThread[] => {
        let threads = byParent.get(parentId)
        if (!threads) {
            threads = anchoredParents.has(parentId) ? chatThreadsFor(parentId, relations, sessions, sources.screen) : []
            byParent.set(parentId, threads)
        }
        return threads
    }
    for (const parentId of parents) {
        const next = chatThreadSnapshot(threadsOf(parentId))
        snapshots.set(parentId, next)
        if (previous.get(parentId) !== next) changed.push(parentId)
    }
    if (!all) return { snapshots, changed }
    // A parent both subscribed and listed is read once: the list reuses that parent's rows.
    const snapshot = chatThreadSnapshot(mergeChatThreads(anchoredParents, sessions, threadsOf))
    return { snapshots, changed, all: { snapshot, changed: all.previous !== snapshot } }
}

/** Every anchored parent's threads as one list, newest activity first. */
export function allChatThreads(anchoredParents: ReadonlySet<string>, relations: SessionRelation[], sessions: ThreadSession[], screen: ThreadScreen): ChatThreadListRow[] {
    if (anchoredParents.size === 0) return []
    return mergeChatThreads(anchoredParents, sessions, (parentId) => chatThreadsFor(parentId, relations, sessions, screen))
}

function mergeChatThreads(anchoredParents: ReadonlySet<string>, sessions: ThreadSession[], threadsOf: (parentId: string) => ChatThread[]): ChatThreadListRow[] {
    const live = new Map(sessions.map((session) => [session.id, session]))
    const rows: ChatThreadListRow[] = []
    for (const parentId of anchoredParents) {
        const parent = live.get(parentId)
        if (!parent) continue
        for (const thread of threadsOf(parentId)) {
            rows.push({ ...thread, parentId, parentName: parent.name, workspaceName: parent.workspaceName ?? '' })
        }
    }
    // The same order the chips use: a click does not reorder it, only new output does.
    return rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.childId.localeCompare(b.childId))
}

/** Only an anchored, outward fork belongs beneath a reply; old Related pairs stay in Related. */
export function chatThreadsFor(parentId: string, relations: SessionRelation[], sessions: ThreadSession[], screen: ThreadScreen): ChatThread[] {
    const live = new Map(sessions.map((session) => [session.id, session]))
    if (!live.has(parentId)) return []
    return relations.flatMap((relation): ChatThread[] => {
        if (relation.dismissed || relation.kind !== 'opened' || relation.from !== parentId || !relation.anchor) return []
        const child = live.get(relation.to)
        if (!child) return []
        const state = screen.hasExited(child.id) ? { busy: false, question: null } : screen.screenStatus(child.id)
        const output = screen.lastOutputAt(child.id)
        const replies = screen.replies?.(child.id, relation.at, output)
        return [{
            childId: child.id,
            name: child.name,
            turnTs: relation.anchor.turnTs,
            ...(relation.anchor.turnIndex === undefined ? {} : { turnIndex: relation.anchor.turnIndex }),
            forkedAt: relation.at,
            status: state.question !== null ? 'waiting' : state.busy ? 'working' : 'idle',
            lastActivityAt: output || relation.at,
            ...(replies === undefined ? {} : { replies })
        }]
    }).sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.childId.localeCompare(b.childId))
}
