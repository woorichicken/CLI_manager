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

const QUOTE_MAX_LINES = 3
const QUOTE_MAX_CHARS = 240

/** A short readable parent paragraph, rather than the answer's Markdown table or source code. */
export function threadQuote(answer: string): string {
    const paragraph: string[] = []
    let fence: { marker: string; length: number } | undefined
    let hasCode = false
    for (const raw of answer.split(/\r?\n/)) {
        const line = raw.trim()
        if (fence) {
            const closing = /^(?<marker>`{3,}|~{3,})\s*$/.exec(line)?.groups?.marker
            if (closing && closing[0] === fence.marker && closing.length >= fence.length) fence = undefined
            continue
        }
        const opening = /^(`{3,}|~{3,})/.exec(line)?.[1]
        if (opening) {
            hasCode = true
            fence = { marker: opening[0], length: opening.length }
            continue
        }
        if (!line) {
            if (paragraph.length > 0) break
            continue
        }
        if (line.startsWith('|') || /^(?:[-*_]\s*){3,}$/.test(line)) continue
        const code: string[] = []
        const plain = line.replace(/`+([^`]+)`+/g, (_match, content: string) => {
            code.push(content)
            return `\u0000${code.length - 1}\u0000`
        })
            .replace(/^#{1,6}\s+/, '').replace(/\s+#+$/, '')
            .replace(/^(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
            .replace(/^>\s?/, '')
            .replace(/!?\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)/g, '$1')
            .replace(/\*\*|__|~~/g, '')
            .replace(/(^|[\s(])([*_])(?=\S)(.+?\S|\S)\2(?=$|[\s).,!?:;])/g, '$1$3')
            .replace(/\u0000(\d+)\u0000/g, (_match, index: string) => code[Number(index)])
            .trim()
        if (plain) paragraph.push(plain)
    }
    if (paragraph.length === 0) return hasCode ? '(code)' : ''
    const text = paragraph.slice(0, QUOTE_MAX_LINES).join('\n')
    if (paragraph.length <= QUOTE_MAX_LINES && text.length <= QUOTE_MAX_CHARS) return text
    let cut = text.slice(0, QUOTE_MAX_CHARS - 1).trimEnd()
    // Avoid cutting an emoji's surrogate pair in half at the character limit.
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1)
    return `${cut}…`
}

/** A question needs the person's attention before another child's ongoing work. */
export function threadStatus(threads: ChatThread[]): ChatThread['status'] {
    if (threads.some((thread) => thread.status === 'waiting')) return 'waiting'
    return threads.some((thread) => thread.status === 'working') ? 'working' : 'idle'
}
