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
            status: state.question !== null ? 'waiting' : state.busy ? 'working' : 'idle',
            lastActivityAt: screen.lastOutputAt(child.id) || relation.at
        }]
    }).sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.childId.localeCompare(b.childId))
}
