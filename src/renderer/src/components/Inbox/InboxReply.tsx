import React, { useState } from 'react'
import { Reply, Send } from 'lucide-react'
import clsx from 'clsx'
import type { ChatSendResult } from '../../../../shared/conversation'

type ReplyState =
    | { state: 'idle' }
    | { state: 'sending' }
    | { state: 'sent' | 'queued' | 'rejected'; message: string }

const SENT_MESSAGE = 'Sent'
const QUEUED_MESSAGE = 'Queued — it goes in when the agent finishes its turn'

/**
 * The row's Reply button (report 5f9002d5). `disabledReason` set: the session is closed or runs no
 * agent, so there is nothing that would read the reply — the button stays, greyed, and says why.
 */
export function InboxReplyToggle({ open, disabledReason, onToggle }: { open: boolean; disabledReason: string | null; onToggle: () => void }) {
    const handleClick = (e: React.MouseEvent): void => {
        // The row behind it opens the session; this only opens the reply box.
        e.stopPropagation()
        if (!disabledReason) onToggle()
    }
    return (
        <button
            data-testid="inbox-reply-toggle"
            data-open={open ? 'true' : 'false'}
            onClick={handleClick}
            onKeyDown={(e) => e.stopPropagation()}
            disabled={Boolean(disabledReason)}
            className={clsx(
                'shrink-0 -my-0.5 p-0.5 rounded text-gray-500 hover:bg-white/10 hover:text-blue-300 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-gray-500',
                open && 'text-blue-300 bg-white/10'
            )}
            title={disabledReason ?? 'Reply\nSends your answer to this session, as the Chat view does. The request stays unread.'}
            aria-label="Reply"
        >
            <Reply size={12} />
        </button>
    )
}

/**
 * The reply box under a request: the text goes to the session through the Chat view's send, so the
 * same rules hold — a question on the agent's screen or text left in its input box refuses it, a
 * working agent gets it when its turn ends, and the session gets no AI mark. Replying does not read
 * the request: only the check or Mark all read does (b165acc4).
 */
export function InboxReplyBox({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const [text, setText] = useState('')
    const [status, setStatus] = useState<ReplyState>({ state: 'idle' })
    const sending = status.state === 'sending'

    const send = async (): Promise<void> => {
        if (sending || !text.trim()) return
        setStatus({ state: 'sending' })
        let result: ChatSendResult
        try {
            result = await window.api.sendChatMessage(sessionId, text)
        } catch {
            result = { status: 'rejected', reason: 'not_running', message: 'Could not reach the session.' }
        }
        if (result.status === 'rejected') {
            // Keep the text: the person answers the question (or clears the box) and sends again.
            setStatus({ state: 'rejected', message: result.message })
            return
        }
        setText('')
        setStatus(result.status === 'queued' ? { state: 'queued', message: QUEUED_MESSAGE } : { state: 'sent', message: SENT_MESSAGE })
    }

    const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
        if (e.key === 'Escape') {
            // The popover closes on Esc from the document; the first Esc closes only this box.
            e.stopPropagation()
            onClose()
            return
        }
        // Enter sends, Shift+Enter is a new line; Enter that ends a Korean/Japanese composition is not a send.
        if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
            e.preventDefault()
            void send()
        }
    }

    return (
        <div data-testid="inbox-reply" className="px-3 pb-2 pl-8">
            <div className="flex items-end gap-1.5">
                <textarea
                    data-testid="inbox-reply-input"
                    autoFocus
                    rows={2}
                    value={text}
                    // readOnly rather than disabled while sending: the caret stays in the box
                    readOnly={sending}
                    onChange={(e) => {
                        setText(e.target.value)
                        if (status.state !== 'sending') setStatus({ state: 'idle' })
                    }}
                    onKeyDown={handleKeyDown}
                    placeholder="Reply to this session…"
                    className="flex-1 min-w-0 resize-none rounded border border-white/15 bg-black/30 px-2 py-1 text-xs text-gray-200 placeholder:text-gray-500 outline-none focus:border-blue-500/70"
                />
                <button
                    data-testid="inbox-reply-send"
                    onClick={() => void send()}
                    disabled={sending || !text.trim()}
                    className="shrink-0 p-1.5 rounded text-blue-300 hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent"
                    title="Send (Enter)"
                    aria-label="Send reply"
                >
                    <Send size={12} />
                </button>
            </div>
            <p
                data-testid="inbox-reply-status"
                data-state={status.state}
                role="status"
                className={clsx(
                    'mt-1 text-[10px]',
                    status.state === 'rejected' ? 'text-red-300' : status.state === 'idle' || status.state === 'sending' ? 'text-gray-500' : 'text-green-300'
                )}
            >
                {status.state === 'idle'
                    ? 'Enter to send · Shift+Enter for a new line · Esc to close'
                    : status.state === 'sending'
                        ? 'Sending…'
                        : status.message}
            </p>
        </div>
    )
}
