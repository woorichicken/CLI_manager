import type { ChatThread, ConversationSnapshot, ConversationTurn } from '../../../../shared/conversation'

/**
 * Native forks copy their parent's turns with the original timestamps, including replies after the
 * anchor. Show only turns written since the relation opened. Undated or invalid times stay hidden:
 * their origin is unknown, so showing them could repeat inherited parent content in the thread.
 */
export function turnsAfterFork(turns: ConversationTurn[], forkedAt: number): ConversationTurn[] {
    if (!Number.isFinite(forkedAt)) return []
    return turns.filter((turn) => turn.ts !== null && Date.parse(turn.ts) >= forkedAt)
}

/**
 * Keep pagination while older child replies may remain beyond the loaded page. Once the page reaches
 * a dated pre-fork turn, the older prefix is copied parent history and needs no thread pagination.
 * Unknown times cannot establish that boundary, so they must not hide potentially earlier replies.
 */
export function hasEarlierThreadReplies(snapshot: ConversationSnapshot, forkedAt: number): boolean {
    return Number.isFinite(forkedAt) && snapshot.totalTurns > snapshot.turns.length &&
        !snapshot.turns.some((turn) => turn.ts !== null && Date.parse(turn.ts) < forkedAt)
}

/** Resolve the exact parent reply in a paged snapshot; a stale indexed anchor must never quote a different reply. */
export function replyForThread(snapshot: ConversationSnapshot, thread: Pick<ChatThread, 'turnTs' | 'turnIndex'>): ConversationTurn | undefined {
    if (thread.turnIndex !== undefined) {
        const localIndex = thread.turnIndex - snapshot.totalTurns + snapshot.turns.length
        const turn = Number.isInteger(localIndex) ? snapshot.turns[localIndex] : undefined
        return turn?.role === 'assistant' && turn.ts === thread.turnTs ? turn : undefined
    }
    return snapshot.turns.find((turn) => turn.role === 'assistant' && turn.ts === thread.turnTs)
}

/** A question needs the person's attention before another child's ongoing work. */
export function threadStatus(threads: ChatThread[]): ChatThread['status'] {
    if (threads.some((thread) => thread.status === 'waiting')) return 'waiting'
    return threads.some((thread) => thread.status === 'working') ? 'working' : 'idle'
}
