import { useState } from 'react'
import { ArrowUp, Clock, Copy, Pencil, X } from 'lucide-react'
import type { ChatTransport, QueuedMessage } from '../../../../shared/conversation'

/**
 * Messages sent while the agent worked, waiting for its turn to end (ovis PendingMessages): each
 * with ↑ Send now (types it now; the agent decides when it reads it), Edit (back into the box),
 * Copy and ✕.
 */
export function QueuedMessages({
    sessionId,
    transport,
    queued,
    agentName,
    onEdit,
    onChanged
}: {
    sessionId: string
    transport: ChatTransport
    queued: QueuedMessage[]
    agentName: string
    onEdit: (text: string) => void
    onChanged: () => void
}) {
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    if (queued.length === 0) return null

    const sendNow = async (message: QueuedMessage): Promise<void> => {
        setBusy(message.id)
        setError(null)
        try {
            const result = await transport.sendQueuedNow(sessionId, message.id)
            if (result.status === 'rejected') setError(result.message)
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
            setBusy(null)
            onChanged()
        }
    }
    /** True when the message was still queued and is withdrawn now. */
    const withdraw = async (message: QueuedMessage): Promise<boolean> => {
        setBusy(message.id)
        setError(null)
        try {
            const withdrawn = await transport.discardQueued(sessionId, message.id)
            if (!withdrawn) setError('It was already sent.')
            return withdrawn
        } catch (failure) {
            setError(`Not withdrawn — it is still queued. ${failure instanceof Error ? failure.message : String(failure)}`)
            return false
        } finally {
            setBusy(null)
            onChanged()
        }
    }
    // Edit brings the text back only once the queue has given it up: otherwise it would be sent twice
    // (ovis useComposerSends.ts:195 — restore after the discarded receipt)
    const edit = async (message: QueuedMessage): Promise<void> => {
        if (await withdraw(message)) onEdit(message.text)
    }

    return (
        <div className="chat-queued" data-testid="chat-queued">
            <ol className="chat-queued-list" aria-label="Queued messages">
                {queued.map((message) => (
                    <li key={message.id} className="chat-queued-item" data-testid="chat-queued-item" data-id={message.id}>
                        <div className="chat-user-bubble is-queued">{message.text}</div>
                        <div className="chat-queued-actions">
                            <button type="button" data-testid="chat-queued-send-now" disabled={busy !== null} title="Send now — the agent reads it when it can" onClick={() => void sendNow(message)}>
                                <ArrowUp size={12} aria-hidden="true" /> Send now
                            </button>
                            <button
                                type="button"
                                data-testid="chat-queued-edit"
                                title="Edit — back into the box"
                                aria-label="Edit queued message"
                                disabled={busy !== null}
                                onClick={() => void edit(message)}
                            >
                                <Pencil size={12} />
                            </button>
                            <button type="button" title="Copy message" aria-label="Copy message" onClick={() => void navigator.clipboard.writeText(message.text).catch(() => undefined)}>
                                <Copy size={12} />
                            </button>
                            <button type="button" data-testid="chat-queued-discard" title="Discard" aria-label="Discard queued message" disabled={busy !== null} onClick={() => void withdraw(message)}>
                                <X size={12} />
                            </button>
                        </div>
                    </li>
                ))}
            </ol>
            <div className="chat-queued-note">
                <Clock size={12} aria-hidden="true" /> {queued.length === 1 ? 'Sends' : 'They send'} when {agentName} finishes this turn
            </div>
            {error && (
                <p className="chat-composer-note is-error" role="alert" data-testid="chat-queued-error">
                    {error}
                </p>
            )}
        </div>
    )
}
