import { useState } from 'react'
import { AlertTriangle } from 'lucide-react'

interface InputBusyNoteProps {
    /** What the agent's input box holds — the refusal's `draft`. */
    draft: string
    /** Sends the message again with that text cleared from the box first. */
    onClearAndSend(): void
    onDismiss(): void
}

/**
 * A send refused because the terminal's input line already holds text (phone-fixes C-1): shows that
 * text, and offers to clear it and send. The text may be what someone at the Mac is typing, so the
 * clear takes a second press. Main clears only while the box still holds exactly this text.
 */
export function InputBusyNote({ draft, onClearAndSend, onDismiss }: InputBusyNoteProps) {
    const [confirming, setConfirming] = useState(false)
    return (
        <div className="chat-composer-note is-error chat-busy-draft" role="alert" data-testid="chat-input-busy" data-state={confirming ? 'confirm' : 'shown'}>
            <p className="chat-busy-draft-line">
                <AlertTriangle size={12} aria-hidden="true" /> Text left in the terminal&apos;s input box:{' '}
                <q className="chat-busy-draft-text" data-testid="chat-input-busy-draft">{draft}</q>
            </p>
            {confirming ? (
                <div className="chat-busy-draft-actions">
                    <span className="chat-busy-draft-ask">Clear it? Someone at the Mac may be typing it.</span>
                    <button type="button" className="chat-busy-draft-button is-danger" data-testid="chat-input-busy-confirm" onClick={onClearAndSend}>
                        Clear and send
                    </button>
                    <button type="button" className="chat-busy-draft-button" data-testid="chat-input-busy-keep" onClick={() => setConfirming(false)}>
                        Keep it
                    </button>
                </div>
            ) : (
                <div className="chat-busy-draft-actions">
                    <button type="button" className="chat-busy-draft-button" data-testid="chat-input-busy-clear" onClick={() => setConfirming(true)}>
                        Clear and send…
                    </button>
                    <button type="button" className="chat-busy-draft-button" data-testid="chat-input-busy-dismiss" onClick={onDismiss}>
                        Not now
                    </button>
                </div>
            )}
        </div>
    )
}
