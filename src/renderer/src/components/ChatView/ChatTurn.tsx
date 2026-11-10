import { memo, useRef, useState } from 'react'
import { Check, Copy, FileText, GitFork } from 'lucide-react'
import type { ConversationAgent, ConversationTurn } from '../../../../shared/conversation'
import { Markdown } from './markdown/Markdown'
import { UserParts } from './TurnParts'
import { WorkBlock } from './WorkBlock'
import { isLiveWorkTurn, turnSegments, workBlockStartsOpen } from './workBlocks'
import { formatElapsed } from './chatLib'

const AGENT_NAMES: Record<ConversationAgent, string> = { claude: 'Claude', codex: 'Codex' }
const COPIED_MS = 1500

/** "14:02" today, "11/2 14:02" another day — on hover (ovis TurnTime). */
function turnTime(ts: string | null): string | undefined {
    if (!ts) return undefined
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return undefined
    const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time}`
}

/** One turn: the person's message as a bubble, or the agent's answer with its work folded in between. */
export const ChatTurn = memo(function ChatTurn({
    turn,
    last,
    working,
    waiting,
    agent,
    index,
    foldWork = true,
    onFork
}: {
    turn: ConversationTurn
    last: boolean
    working: boolean
    /** a question menu is on screen: the running turn waits on the person */
    waiting: boolean
    agent: ConversationAgent
    /** its place among the turns shown, for the rail's jumps */
    index: number
    /** Settings › Terminal › Chat view «Collapse work» (default on): every block starts folded */
    foldWork?: boolean
    /** «Fork into a new session» from this reply (its place among the turns shown); absent: no button */
    onFork?: (index: number) => void
}) {
    if (turn.role === 'user') {
        return (
            <div className="chat-turn chat-turn-user" data-testid="chat-turn" data-role="user" data-turn-index={index} title={turnTime(turn.ts)}>
                <UserParts parts={turn.parts} />
            </div>
        )
    }
    const live = isLiveWorkTurn(turn, last, working || waiting)
    const segments = turnSegments(turn.parts)
    const answer = segments
        .filter((segment) => segment.kind === 'answer')
        .flatMap((segment) => segment.parts.map((part) => part.text))
        .join('\n\n')
    return (
        <div className="chat-turn chat-turn-assistant" data-testid="chat-turn" data-role="assistant" data-turn-index={index}>
            <div className="chat-turn-label">
                <span title={turnTime(turn.end_ts ?? turn.ts)}>{AGENT_NAMES[agent]}</span>
                {answer && !(live && last) && <CopyAnswer markdown={answer} />}
                {answer && !(live && last) && onFork && (
                    <span className="chat-copy-answer">
                        <button
                            type="button"
                            data-testid="chat-fork"
                            title="Fork into a new session"
                            aria-label="Fork into a new session"
                            // the keyboard stays where it was (the message box): the dialog gives it back there on close
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={() => onFork(index)}
                        >
                            <GitFork size={12} />
                        </button>
                    </span>
                )}
            </div>
            {segments.map((segment, segmentIndex) => {
                const lastSegment = segmentIndex === segments.length - 1
                if (segment.kind === 'answer') {
                    return (
                        <div key={`a-${segment.start}`} data-testid="chat-answer">
                            {segment.parts.map((part, partIndex) => (
                                <Markdown key={partIndex}>{part.text}</Markdown>
                            ))}
                        </div>
                    )
                }
                return (
                    <WorkBlock
                        key={`w-${segment.start}`}
                        parts={segment.parts}
                        live={live && lastSegment}
                        waiting={waiting && live && lastSegment}
                        startsOpen={workBlockStartsOpen({ live: live && lastSegment, waiting: waiting && live && lastSegment, last: lastSegment }, turn.parts, foldWork)}
                        startTs={turn.ts}
                        endTs={turn.end_ts}
                    />
                )
            })}
            {turn.done && !(live && last) && (
                // Claude's own turn-end line: how long the turn took and when it ended (fb-1110 a0ba98c4)
                <div className="chat-turn-done" data-testid="chat-turn-done" title={new Date(turn.done.at).toLocaleString()}>
                    Took {formatElapsed(turn.done.ms)} · done {clockTime(turn.done.at)}
                </div>
            )}
            {turn.recap && (
                <div className="chat-recap" data-testid="chat-recap">
                    <span className="chat-recap-label">※ recap</span> {turn.recap}
                </div>
            )}
        </div>
    )
})

/** «2:14 PM» today, «11/9 2:14 PM» another day — the turn-end line's «done» time. */
function clockTime(ts: string): string {
    const date = new Date(ts)
    if (Number.isNaN(date.getTime())) return ''
    const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time}`
}

/**
 * Copy an answer as Markdown (what the agent wrote) or as plain text (what the chat shows: the
 * rendered words, without `**` and fences) — ovis "Copy an answer as Markdown or plain text".
 */
function CopyAnswer({ markdown }: { markdown: string }) {
    const [copied, setCopied] = useState<'md' | 'text' | null>(null)
    const anchor = useRef<HTMLSpanElement>(null)
    const copy = async (kind: 'md' | 'text'): Promise<void> => {
        let text = markdown
        if (kind === 'text') {
            const turn = anchor.current?.closest('[data-role="assistant"]')
            const answers = turn ? Array.from(turn.querySelectorAll<HTMLElement>('[data-testid="chat-answer"]')) : []
            text = answers.map((element) => element.innerText.trim()).join('\n\n')
        }
        try {
            await navigator.clipboard.writeText(text)
            setCopied(kind)
            window.setTimeout(() => setCopied(null), COPIED_MS)
        } catch {
            setCopied(null)
        }
    }
    return (
        <span className="chat-copy-answer" ref={anchor}>
            <button type="button" data-testid="chat-copy-markdown" title="Copy answer as Markdown" aria-label="Copy answer as Markdown" onClick={() => void copy('md')}>
                {copied === 'md' ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button type="button" data-testid="chat-copy-text" title="Copy answer as plain text" aria-label="Copy answer as plain text" onClick={() => void copy('text')}>
                {copied === 'text' ? <Check size={12} /> : <FileText size={12} />}
            </button>
        </span>
    )
}
