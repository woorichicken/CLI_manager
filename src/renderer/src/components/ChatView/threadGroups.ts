import type { ChatThread } from '../../../../shared/conversation'

export type ThreadGroups = Map<string, ChatThread[]>

function turnKey(turnTs: string | null, turnIndex?: number): string {
    return JSON.stringify([turnTs, turnIndex ?? null])
}

/** IPC returns new objects; equal rows should still leave a memoized answer alone. */
function sameThread(left: ChatThread, right: ChatThread): boolean {
    return left.childId === right.childId && left.name === right.name && left.turnTs === right.turnTs &&
        left.turnIndex === right.turnIndex && left.forkedAt === right.forkedAt && left.status === right.status && left.lastActivityAt === right.lastActivityAt
}

/**
 * Group only when the thread list changes, independent of streaming conversation snapshots. Older
 * anchors without an index apply to every matching timestamp, in the same order as indexed anchors.
 * Reuse unchanged groups across reads, including when another answer's threads changed.
 */
export function groupThreadsByTurn(threads: ChatThread[], previous?: ThreadGroups): ThreadGroups {
    const byTimestamp = new Map<string | null, ChatThread[]>()
    for (const thread of threads) {
        const rows = byTimestamp.get(thread.turnTs)
        if (rows) rows.push(thread)
        else byTimestamp.set(thread.turnTs, [thread])
    }

    const groups: ThreadGroups = new Map()
    const keep = (turnTs: string | null, turnIndex: number | undefined, rows: ChatThread[]): void => {
        if (rows.length === 0) return
        const key = turnKey(turnTs, turnIndex)
        const prior = previous?.get(key)
        groups.set(key, prior && prior.length === rows.length && prior.every((row, index) => sameThread(row, rows[index])) ? prior : rows)
    }
    for (const [turnTs, rows] of byTimestamp) {
        keep(turnTs, undefined, rows.filter((thread) => thread.turnIndex === undefined))
        const indexes = new Set(rows.flatMap((thread) => thread.turnIndex === undefined ? [] : [thread.turnIndex]))
        for (const index of indexes) {
            keep(turnTs, index, rows.filter((thread) => thread.turnIndex === undefined || thread.turnIndex === index))
        }
    }
    return groups
}

/** Undefined is a stable prop for every answer without threads, even after a new grouping. */
export function threadsForTurn(groups: ThreadGroups, turnTs: string | null, globalIndex: number): ChatThread[] | undefined {
    return groups.get(turnKey(turnTs, globalIndex)) ?? groups.get(turnKey(turnTs))
}
