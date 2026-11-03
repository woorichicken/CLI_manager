import { memo } from 'react'
import type { ConversationAgent, ConversationTurn } from '../../../../shared/conversation'
import { Markdown } from './markdown/Markdown'
import { UserParts } from './TurnParts'
import { WorkBlock } from './WorkBlock'
import { isLiveWorkTurn, turnSegments, workStartsOpen } from './workBlocks'

const AGENT_NAMES: Record<ConversationAgent, string> = { claude: 'Claude', codex: 'Codex' }

/** One turn: the person's message as a bubble, or the agent's answer with its work folded in between. */
export const ChatTurn = memo(function ChatTurn({
    turn,
    last,
    working,
    waiting,
    agent
}: {
    turn: ConversationTurn
    last: boolean
    working: boolean
    /** a question menu is on screen: the running turn waits on the person */
    waiting: boolean
    agent: ConversationAgent
}) {
    if (turn.role === 'user') {
        return (
            <div className="chat-turn chat-turn-user" data-testid="chat-turn" data-role="user">
                <UserParts parts={turn.parts} />
            </div>
        )
    }
    const live = isLiveWorkTurn(turn, last, working || waiting)
    const segments = turnSegments(turn.parts)
    const settledOpen = workStartsOpen(false, turn.parts)
    return (
        <div className="chat-turn chat-turn-assistant" data-testid="chat-turn" data-role="assistant">
            <div className="chat-turn-label">{AGENT_NAMES[agent]}</div>
            {segments.map((segment, index) => {
                const lastSegment = index === segments.length - 1
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
                        startsOpen={(live && lastSegment) || (lastSegment && settledOpen)}
                        startTs={turn.ts}
                        endTs={turn.end_ts}
                    />
                )
            })}
        </div>
    )
})
