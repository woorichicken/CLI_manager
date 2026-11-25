import { memo, useRef, useState } from 'react'
import { Bot, Check, Copy, FileText, GitFork } from 'lucide-react'
import type { ChatAgent, ChatThread, ConversationTurn } from '../../../../shared/conversation'
import { Markdown } from './markdown/Markdown'
import { UserParts } from './TurnParts'
import { WorkBlock } from './WorkBlock'
import { isLiveWorkTurn, turnSegments, workBlockStartsOpen } from './workBlocks'
import { answerForAgent, formatElapsed, INTERRUPTED_TEXT } from './chatLib'
import { ThreadChip } from './ThreadChip'

const AGENT_NAMES: Record<ChatAgent, string> = { claude: 'Claude', codex: 'Codex', agy: 'Antigravity' }
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
    onFork,
    threads,
    onOpenThread,
    sessionId,
    sessionName,
    answerNumber,
    answerTotal
}: {
    turn: ConversationTurn
    last: boolean
    working: boolean
    /** a question menu is on screen: the running turn waits on the person */
    waiting: boolean
    agent: ChatAgent
    /** its place among the turns shown, for the rail's jumps */
    index: number
    /** Settings › Chat «Collapse work» (default on): every block starts folded */
    foldWork?: boolean
    /** Reply in thread; Shift opens the existing fork options. */
    onFork?: (index: number, options: boolean) => void
    threads?: ChatThread[]
    onOpenThread?: (childId: string) => void
    /** for «Copy for agent»: which session, and which of its answers this is (1-based; absent when not all are read) */
    sessionId?: string
    sessionName?: string
    answerNumber?: number
    answerTotal?: number
}) {
    if (turn.role === 'user') {
        // the person's own words, to copy back (16f1402e) — not the «Stopped» marker
        const said = turn.parts
            .flatMap((part) => (part.kind === 'text' && !INTERRUPTED_TEXT.test(part.text.trim()) ? [part.text] : []))
            .join('\n\n')
        return (
            <div className="chat-turn chat-turn-user" data-testid="chat-turn" data-role="user" data-turn-index={index} title={turnTime(turn.ts)}>
                <UserParts parts={turn.parts} last={last} />
                {said.trim() && <CopyMine text={said} />}
            </div>
        )
    }
    const live = isLiveWorkTurn(turn, last, working || waiting)
    const segments = turnSegments(turn.parts)
    const answer = segments
        .filter((segment) => segment.kind === 'answer')
        .flatMap((segment) => segment.parts.map((part) => part.text))
        .join('\n\n')
    const settled = !(live && last)
    return (
        <div className="chat-turn chat-turn-assistant" data-testid="chat-turn" data-role="assistant" data-turn-index={index}>
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
            {/* Who answered sits on the turn's last line, beside how long it took (e9756d90) — no header line over
                the answer. A turn without Claude's turn-end record (working, Codex, an older record) still says who. */}
            <div className="chat-turn-foot" data-testid="chat-turn-foot">
                <span className="chat-turn-agent" data-testid="chat-turn-agent" title={turnTime(turn.end_ts ?? turn.ts)}>{AGENT_NAMES[agent]}</span>
                {turn.done && settled && (
                    <>
                        <span aria-hidden="true">·</span>
                        {/* Claude's own turn-end line: how long the turn took and when it ended (fb-1110 a0ba98c4) */}
                        <span className="chat-turn-done" data-testid="chat-turn-done" title={new Date(turn.done.at).toLocaleString()}>
                            Took {formatElapsed(turn.done.ms)} · done {clockTime(turn.done.at)}
                        </span>
                    </>
                )}
                {answer && settled && (
                    <CopyAnswer
                        markdown={answer}
                        forAgent={sessionId ? () => answerForAgent({ sessionName, sessionId, at: turn.end_ts ?? turn.ts, answerNumber, answerTotal, answer }) : undefined}
                    />
                )}
                {answer && settled && onFork && (
                    <span className="chat-copy-answer">
                        <button
                            type="button"
                            data-testid="chat-fork"
                            title="Reply in thread (Shift+click for options)"
                            aria-label="Reply in thread"
                            // the keyboard stays where it was (the message box): the dialog gives it back there on close
                            onMouseDown={(event) => event.preventDefault()}
                            onClick={(event) => onFork(index, event.shiftKey)}
                        >
                            <GitFork size={12} />
                        </button>
                    </span>
                )}
            </div>
            {turn.recap && (
                <div className="chat-recap" data-testid="chat-recap">
                    <span className="chat-recap-label">※ recap</span> {turn.recap}
                </div>
            )}
            {threads && threads.length > 0 && onOpenThread && <ThreadChip threads={threads} onOpen={onOpenThread} />}
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

/** Copy what the person sent, as they wrote it. */
function CopyMine({ text }: { text: string }) {
    const [copied, setCopied] = useState(false)
    const copy = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(text)
            setCopied(true)
            window.setTimeout(() => setCopied(false), COPIED_MS)
        } catch {
            setCopied(false)
        }
    }
    return (
        <span className="chat-copy-answer chat-copy-mine">
            <button type="button" data-testid="chat-copy-mine" title="Copy your message" aria-label="Copy your message" onClick={() => void copy()}>
                {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
        </span>
    )
}

/**
 * Copy an answer as Markdown (what the agent wrote) or as plain text (what the chat shows: the
 * rendered words, without `**` and fences) — ovis "Copy an answer as Markdown or plain text".
 */
function CopyAnswer({ markdown, forAgent }: { markdown: string; forAgent?: () => string }) {
    const [copied, setCopied] = useState<'md' | 'text' | 'agent' | null>(null)
    const anchor = useRef<HTMLSpanElement>(null)
    const copy = async (kind: 'md' | 'text' | 'agent'): Promise<void> => {
        let text = markdown
        if (kind === 'agent' && forAgent) text = forAgent()
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
            {forAgent && (
                // for another agent: the session's name and link and the turn's place and time over the answer (45127b82)
                <button type="button" data-testid="chat-copy-for-agent" title="Copy for agent — the answer with its session link, turn and time" aria-label="Copy answer for an agent" onClick={() => void copy('agent')}>
                    {copied === 'agent' ? <Check size={12} /> : <Bot size={12} />}
                </button>
            )}
        </span>
    )
}
