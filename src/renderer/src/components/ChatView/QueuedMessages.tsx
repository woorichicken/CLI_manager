import { useEffect, useState } from 'react'
import { ArrowUp, Clock, Copy, Pencil, X } from 'lucide-react'
import type { ChatTransport, QueuedMessage } from '../../../../shared/conversation'

/**
 * Messages sent while the agent worked, waiting for its turn to end (ovis PendingMessages): each
 * with ↑ Send now (types it now; the agent decides when it reads it), Edit (back into the box),
 * Copy and ✕.
 *
 * Send now and ✕ show at once, before the Mac answers (fb-1110 e4ce1a2f: on a phone the row stayed as it
 * was for the request and the conversation read after it, and looked like nothing happened). ✕ hides the
 * row, Send now marks it «Sending…»; a refusal or a failure brings the row back with the reason. Edit still
 * waits: its text goes back into the box only once the queue has given it up (sent twice otherwise).
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
    /** `sessionId`: the session the message was withdrawn from — the view may show another one by then */
    onEdit: (text: string, sessionId: string) => void
    onChanged: () => void
}) {
    const [busy, setBusy] = useState<string | null>(null)
    const [error, setError] = useState<string | null>(null)
    /** what was pressed on a row, shown before the Mac answers: id → sending (Send now) or gone (✕) */
    const [pressed, setPressed] = useState<ReadonlyMap<string, 'sending' | 'gone'>>(new Map())
    const mark = (id: string, state: 'sending' | 'gone' | null): void =>
        setPressed((current) => {
            const next = new Map(current)
            if (state) next.set(id, state)
            else next.delete(id)
            return next
        })
    // a row the queue no longer has needs no mark; another session (a phone reuses the view) starts clean
    const ids = queued.map((message) => message.id).join('\n')
    useEffect(() => {
        const present = new Set(ids.split('\n'))
        setPressed((current) => ([...current.keys()].every((id) => present.has(id)) ? current : new Map([...current].filter(([id]) => present.has(id)))))
    }, [ids])
    useEffect(() => {
        setPressed(new Map())
        setError(null)
    }, [sessionId])
    const shown = queued.filter((message) => pressed.get(message.id) !== 'gone')
    if (shown.length === 0) return null
    /** rows still waiting for the turn to end (not the ones on their way now) */
    const waiting = shown.filter((message) => pressed.get(message.id) !== 'sending').length

    const sendNow = async (message: QueuedMessage): Promise<void> => {
        mark(message.id, 'sending')
        setError(null)
        try {
            const result = await transport.sendQueuedNow(sessionId, message.id)
            if (result.status === 'rejected') {
                mark(message.id, null)
                setError(result.message)
            }
        } catch (failure) {
            mark(message.id, null)
            setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
            onChanged()
        }
    }
    /** ✕: the row goes at once; back with the reason when it could not be withdrawn and is still queued */
    const discard = async (message: QueuedMessage): Promise<void> => {
        mark(message.id, 'gone')
        setError(null)
        try {
            // false: it was sent already — it shows as sent, not queued, so the row stays gone
            await transport.discardQueued(sessionId, message.id)
        } catch (failure) {
            mark(message.id, null)
            setError(`Not withdrawn — it is still queued. ${failure instanceof Error ? failure.message : String(failure)}`)
        } finally {
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
    // the session is fixed now: the phone reuses this view for the next session it opens while
    // the withdrawal is on its way (round2 N01)
    const edit = async (message: QueuedMessage): Promise<void> => {
        const from = sessionId
        if (await withdraw(message)) onEdit(message.text, from)
    }

    return (
        <div className="chat-queued" data-testid="chat-queued">
            <ol className="chat-queued-list" aria-label="Queued messages">
                {shown.map((message) => (
                    <li key={message.id} className="chat-queued-item" data-testid="chat-queued-item" data-id={message.id} data-state={pressed.get(message.id) ?? 'queued'}>
                        <div className="chat-user-bubble is-queued">{message.text}</div>
                        {pressed.get(message.id) === 'sending' ? (
                            <div className="chat-queued-actions" data-testid="chat-queued-sending">
                                <span className="chat-queued-sending">
                                    <ArrowUp size={12} aria-hidden="true" /> Sending…
                                </span>
                            </div>
                        ) : (
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
                            <button type="button" data-testid="chat-queued-discard" title="Discard" aria-label="Discard queued message" disabled={busy !== null} onClick={() => void discard(message)}>
                                <X size={12} />
                            </button>
                        </div>
                        )}
                    </li>
                ))}
            </ol>
            {waiting > 0 && (
                <div className="chat-queued-note">
                    <Clock size={12} aria-hidden="true" /> {waiting === 1 ? 'Sends' : 'They send'} when {agentName} finishes this turn
                </div>
            )}
            {error && (
                <p className="chat-composer-note is-error" role="alert" data-testid="chat-queued-error">
                    {error}
                </p>
            )}
        </div>
    )
}
