import type { ChatThread } from '../shared/conversation'
import type { SessionRelation } from '../shared/types'

interface ThreadSession {
    id: string
    name: string
}

interface ThreadScreen {
    hasExited(id: string): boolean
    screenStatus(id: string): { busy: boolean; question: string | null }
    lastOutputAt(id: string): number
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

/** One tick shares its reads across parents; inactive parents still publish an emptied list. */
export function pollChatThreadChanges(parents: ReadonlySet<string>, anchoredParents: ReadonlySet<string>, previous: ReadonlyMap<string, string>, sources: ThreadSources): { snapshots: Map<string, string>; changed: string[] } {
    const hasThreads = [...parents].some((id) => anchoredParents.has(id))
    const relations = hasThreads ? sources.relations() : []
    const sessions = hasThreads ? sources.sessions() : []
    const snapshots = new Map<string, string>()
    const changed: string[] = []
    for (const parentId of parents) {
        const threads = anchoredParents.has(parentId) ? chatThreadsFor(parentId, relations, sessions, sources.screen) : []
        const next = chatThreadSnapshot(threads)
        snapshots.set(parentId, next)
        if (previous.get(parentId) !== next) changed.push(parentId)
    }
    return { snapshots, changed }
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
        return [{
            childId: child.id,
            name: child.name,
            turnTs: relation.anchor.turnTs,
            ...(relation.anchor.turnIndex === undefined ? {} : { turnIndex: relation.anchor.turnIndex }),
            forkedAt: relation.at,
            status: state.question !== null ? 'waiting' : state.busy ? 'working' : 'idle',
            lastActivityAt: screen.lastOutputAt(child.id) || relation.at
        }]
    }).sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.childId.localeCompare(b.childId))
}
