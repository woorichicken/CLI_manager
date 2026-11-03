import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDown, Clock, Loader2, Terminal as TerminalIcon, X } from 'lucide-react'
import type { ChatTransport, ConversationAgent, ConversationSnapshot } from '../../../../shared/conversation'
import { ChatTurn } from './ChatTurn'
import { Composer } from './Composer'
import { PromptCard } from './PromptCard'
import { useConversation } from './useConversation'
import './chat.css'

/**
 * The Chat view: the same session as its terminal, read from the agent's own
 * transcript — the person's messages, the answers (Markdown, tables, colored
 * code), each turn's work folded under one row, "working" while a turn runs,
 * the agent's question as a card, and a box to send the next message. The
 * terminal keeps running underneath; "Terminal" in the header goes back to it.
 *
 * Talks to the app only through `transport` (no `window.api` in this folder):
 * the Electron app passes IPC, a phone page can pass HTTP.
 */
export interface ChatViewProps {
    sessionId: string
    transport: ChatTransport
    onOpenTerminal: () => void
    fontSize?: number
}

/** Within this many pixels of the end, new turns keep the view pinned to the bottom. */
const STICK_PX = 80

const NAMES: Record<ConversationAgent, string> = { claude: 'Claude', codex: 'Codex' }

export function ChatView({ sessionId, transport, onOpenTerminal, fontSize = 14 }: ChatViewProps) {
    const { snapshot, refresh } = useConversation(transport, sessionId)
    const scroller = useRef<HTMLDivElement>(null)
    const pinned = useRef(true)
    const [showJump, setShowJump] = useState(false)

    // Opening a chat starts at its end.
    useEffect(() => {
        pinned.current = true
    }, [sessionId])

    useLayoutEffect(() => {
        const element = scroller.current
        if (!element || !pinned.current) return
        element.scrollTop = element.scrollHeight
    }, [snapshot])

    const onScroll = (): void => {
        const element = scroller.current
        if (!element) return
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
        pinned.current = atBottom
        setShowJump(!atBottom)
    }

    const jumpToEnd = (): void => {
        const element = scroller.current
        if (!element) return
        element.scrollTop = element.scrollHeight
        pinned.current = true
        setShowJump(false)
    }

    const agentName = snapshot?.agent ? NAMES[snapshot.agent] : 'the agent'
    return (
        <div className="chat-view" data-testid="chat-view" data-session-id={sessionId} style={{ fontSize: `${fontSize}px` }}>
            <div className="chat-scroll" ref={scroller} onScroll={onScroll}>
                <div className="chat-column">
                    {snapshot === null ? (
                        <div className="chat-empty">
                            <Loader2 size={16} className="animate-spin" /> Reading the conversation…
                        </div>
                    ) : snapshot.unavailable ? (
                        <Unavailable snapshot={snapshot} onOpenTerminal={onOpenTerminal} />
                    ) : (
                        <Turns snapshot={snapshot} />
                    )}
                    {snapshot && snapshot.queued.length > 0 && (
                        <div className="chat-queued" data-testid="chat-queued">
                            {snapshot.queued.map((text, index) => (
                                <div key={index} className="chat-user-bubble is-queued">
                                    {text}
                                </div>
                            ))}
                            <div className="chat-queued-note">
                                <Clock size={12} aria-hidden="true" /> Sends when {agentName} finishes this turn
                                <button type="button" className="chat-link-button" onClick={() => void transport.cancelQueued(sessionId).then(refresh)}>
                                    <X size={12} aria-hidden="true" /> Cancel
                                </button>
                            </div>
                        </div>
                    )}
                    {snapshot?.working && !snapshot.prompt && (
                        <div className="chat-working" data-testid="chat-working">
                            <Loader2 size={13} className="animate-spin text-blue-300" aria-hidden="true" /> {agentName} is working…
                        </div>
                    )}
                </div>
            </div>
            {showJump && (
                <button type="button" className="chat-jump" onClick={jumpToEnd} aria-label="Jump to the latest message">
                    <ArrowDown size={14} />
                </button>
            )}
            <div className="chat-bottom">
                <div className="chat-column">
                    {snapshot?.prompt && (
                        <PromptCard sessionId={sessionId} prompt={snapshot.prompt} transport={transport} onOpenTerminal={onOpenTerminal} onAnswered={refresh} />
                    )}
                    <Composer
                        sessionId={sessionId}
                        transport={transport}
                        agentName={agentName}
                        disabled={Boolean(snapshot?.prompt)}
                        disabledReason="Answer the question above first"
                        onSent={refresh}
                    />
                </div>
            </div>
        </div>
    )
}

function Turns({ snapshot }: { snapshot: ConversationSnapshot }) {
    const agent = snapshot.agent ?? 'claude'
    const hidden = snapshot.totalTurns - snapshot.turns.length
    return (
        <>
            {(snapshot.truncated || hidden > 0) && (
                <div className="chat-older-note" data-testid="chat-older-note">
                    {snapshot.truncated
                        ? 'Earlier turns are not shown — the conversation file is large. Scroll the terminal for them.'
                        : `Showing the last ${snapshot.turns.length} of ${snapshot.totalTurns} turns.`}
                </div>
            )}
            {snapshot.turns.length === 0 && <div className="chat-empty">No messages yet. Send one below.</div>}
            {snapshot.turns.map((turn, index) => (
                <ChatTurn
                    key={`${index}-${turn.ts ?? ''}`}
                    turn={turn}
                    last={index === snapshot.turns.length - 1}
                    working={snapshot.working}
                    agent={agent}
                />
            ))}
        </>
    )
}

function Unavailable({ snapshot, onOpenTerminal }: { snapshot: ConversationSnapshot; onOpenTerminal: () => void }) {
    const text =
        snapshot.unavailable === 'no-conversation'
            ? 'No Claude Code or Codex conversation is linked to this session yet. Start claude or codex in the terminal and the chat follows it.'
            : snapshot.unavailable === 'not-found'
              ? 'The conversation file for this session was not found. It may still be starting, or it was deleted.'
              : 'The conversation file could not be read.'
    return (
        <div className="chat-empty" data-testid="chat-unavailable" data-reason={snapshot.unavailable}>
            <p>{text}</p>
            <button type="button" className="chat-link-button" onClick={onOpenTerminal}>
                <TerminalIcon size={12} aria-hidden="true" /> Open the terminal
            </button>
        </div>
    )
}
