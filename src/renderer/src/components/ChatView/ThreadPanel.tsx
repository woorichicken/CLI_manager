import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { ExternalLink, MessagesSquare, X } from 'lucide-react'
import type { ChatThread } from '../../../../shared/conversation'

const STATUS_WORDS: Record<ChatThread['status'], string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Idle' }

/** A shell around a child ChatView: keeping it as children avoids a recursive view import. */
export function ThreadPanel({ thread, agentName, quote, onClose, onOpenSession, children }: {
    thread: ChatThread
    agentName: string
    quote: string
    onClose: () => void
    onOpenSession?: () => void
    children: ReactNode
}) {
    const panel = useRef<HTMLElement>(null)
    useLayoutEffect(() => {
        panel.current?.focus({ preventScroll: true })
    }, [thread.childId])
    return (
        <aside
            ref={panel}
            className="chat-thread-panel"
            data-testid="chat-thread-panel"
            data-session-id={thread.childId}
            aria-label={`Thread: ${thread.name}`}
            tabIndex={-1}
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || event.defaultPrevented) return
                event.preventDefault()
                event.stopPropagation()
                onClose()
            }}
        >
            <header className="chat-thread-panel-header">
                <div className="chat-thread-panel-title">
                    <MessagesSquare size={15} aria-hidden="true" />
                    <span className="chat-thread-panel-name" title={thread.name}>{thread.name}</span>
                </div>
                <div className="chat-thread-panel-actions">
                    {onOpenSession && <button type="button" className="chat-thread-open-session" data-testid="chat-thread-open-session" onClick={onOpenSession} title="Open as session">
                        <ExternalLink size={12} aria-hidden="true" /> Open as session
                    </button>}
                    <button type="button" className="chat-thread-panel-close" data-testid="chat-thread-panel-close" title="Close thread" aria-label="Close thread" onClick={onClose}>
                        <X size={16} aria-hidden="true" />
                    </button>
                </div>
                <div className="chat-thread-panel-status">
                    <span className="chat-thread-status-dot" data-testid="chat-thread-status-dot" data-status={thread.status} aria-hidden="true" />
                    <span>{STATUS_WORDS[thread.status]}</span>
                </div>
            </header>
            <div className="chat-thread-quote" data-testid="chat-thread-quote">
                <div className="chat-thread-quote-label">Replying to {agentName}</div>
                {quote && <blockquote>{quote}</blockquote>}
            </div>
            <div className="chat-thread-body">{children}</div>
        </aside>
    )
}
