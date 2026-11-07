import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, ExternalLink } from 'lucide-react'
import type { ChatSendResult } from '../../../shared/conversation'
import type { PhoneDocTarget } from '../../../shared/phone'
import { PHONE_MAX_COMMENT_CHARS } from '../../../shared/phone'
import { InputBusyNote } from '../components/ChatView/InputBusyNote'
import { chatPath, getSessions, PhoneApiError, postJson } from './api'
import { commentTooLong, sendOutcome, type SendOutcome } from './docMessages'

/**
 * What a document's comment is about to do, in the phone page's own hands: the words in full, who gets them, and the one
 * button that sends them (decision 0011). Nothing the document does can press it. It goes through the chat's own route,
 * so a question on screen or text in the Mac's box refuses it the way they refuse a typed message.
 */

/** A finger that opened this by pressing a button in the page would otherwise land on Send by staying put. */
const ARM_MS = 600

type Refusal = Extract<SendOutcome, { kind: 'refused' }>

export function DocSendSheet({ text, target: initial, onCancel, onDone, onOpenChat }: { text: string; target: PhoneDocTarget | null; onCancel: () => void; onDone: (notice: string, target: PhoneDocTarget) => void; onOpenChat: (sessionId: string) => void }) {
    const [target, setTarget] = useState(initial)
    const [choices, setChoices] = useState<PhoneDocTarget[] | null>(null)
    const [armed, setArmed] = useState(false)
    const [sending, setSending] = useState(false)
    const [refusal, setRefusal] = useState<Refusal | null>(null)
    const [busyDraft, setBusyDraft] = useState<string | null>(null)
    useEffect(() => {
        const timer = window.setTimeout(() => setArmed(true), ARM_MS)
        return () => window.clearTimeout(timer)
    }, [])

    const pick = initial === null || refusal?.pick === true
    useEffect(() => {
        if (!pick || choices) return
        let stale = false
        getSessions()
            .then((list) => {
                if (stale) return
                setChoices(list.sessions.flatMap((session) => (session.agent ? [{ id: session.id, name: session.name, agent: session.agent }] : [])))
            })
            .catch(() => undefined)
        return () => {
            stale = true
        }
    }, [pick, choices])

    const send = useCallback(
        async (clearDraft?: string): Promise<void> => {
            if (!target) return
            setSending(true)
            setRefusal(null)
            setBusyDraft(null)
            let outcome: SendOutcome
            try {
                const result = await postJson<ChatSendResult>(chatPath(target.id, 'send'), { text, ...(clearDraft !== undefined ? { clearDraft } : {}) })
                outcome = sendOutcome(result, target)
            } catch (error) {
                // the server's own gates (view only, the phone switched off) say so; anything else never got there
                outcome = { kind: 'refused', message: error instanceof PhoneApiError ? error.message : 'The Mac is not answering', retry: !(error instanceof PhoneApiError), pick: false, openChat: false }
            }
            setSending(false)
            if (outcome.kind === 'done') onDone(outcome.notice, target)
            else if (outcome.kind === 'busy') setBusyDraft(outcome.draft)
            else setRefusal(outcome)
        },
        [target, text, onDone]
    )

    const tooLong = commentTooLong(text)
    const blocked = refusal !== null && !refusal.retry
    return (
        <>
            <div className="phone-doc-scrim" aria-hidden="true" />
            <section className="phone-doc-sheet" role="dialog" aria-label="Send this comment" data-testid="phone-doc-sheet">
                <header className="phone-doc-sheet-head">
                    <span>Send to</span>
                    {pick && choices ? (
                        <select
                            className="phone-doc-select"
                            data-testid="phone-doc-target-select"
                            value={target?.id ?? ''}
                            onChange={(event) => {
                                setTarget(choices.find((choice) => choice.id === event.target.value) ?? null)
                                setRefusal(null)
                                setBusyDraft(null)
                            }}
                        >
                            {!choices.some((choice) => choice.id === target?.id) && <option value="">Choose a session…</option>}
                            {choices.map((choice) => (
                                <option key={choice.id} value={choice.id}>
                                    {choice.name}
                                </option>
                            ))}
                        </select>
                    ) : (
                        <strong data-testid="phone-doc-target">{target?.name ?? 'Choose a session…'}</strong>
                    )}
                </header>
                {/* all of it, scrolled: what a page wrote here goes to the agent as if typed */}
                <pre className="phone-doc-text" data-testid="phone-doc-text">
                    {text}
                </pre>
                {tooLong && (
                    <p className="phone-doc-sheet-note is-error" role="alert" data-testid="phone-doc-too-long">
                        <AlertTriangle size={12} aria-hidden="true" /> {text.length.toLocaleString()} characters. A comment can hold {PHONE_MAX_COMMENT_CHARS.toLocaleString()}.
                    </p>
                )}
                {busyDraft !== null && <InputBusyNote key={busyDraft} draft={busyDraft} onClearAndSend={() => void send(busyDraft)} onDismiss={() => setBusyDraft(null)} />}
                {refusal && (
                    <p className="phone-doc-sheet-note is-error" role="alert" data-testid="phone-doc-refusal">
                        <AlertTriangle size={12} aria-hidden="true" /> {refusal.message}
                    </p>
                )}
                <footer className="phone-doc-sheet-foot">
                    {refusal?.openChat && target && (
                        <button type="button" className="phone-doc-button" data-testid="phone-doc-open-chat" onClick={() => onOpenChat(target.id)}>
                            Open chat
                        </button>
                    )}
                    <button type="button" className="phone-doc-button" data-testid="phone-doc-cancel" onClick={onCancel}>
                        Cancel
                    </button>
                    {!blocked && (
                        <button type="button" className="phone-doc-button is-primary" data-testid="phone-doc-send" disabled={!armed || sending || tooLong || !target || busyDraft !== null} onClick={() => void send()}>
                            {sending ? 'Sending…' : refusal ? 'Send again' : 'Send'}
                        </button>
                    )}
                </footer>
            </section>
        </>
    )
}

/** A link to the web: a real link for the person to press. The frame cannot open anything, and this page does not on its behalf. */
export function DocLinkSheet({ url, onCancel }: { url: string; onCancel: () => void }) {
    return (
        <>
            <div className="phone-doc-scrim" aria-hidden="true" />
            <section className="phone-doc-sheet" role="dialog" aria-label="Open this link" data-testid="phone-doc-sheet">
                <p className="phone-doc-url">{url}</p>
                <footer className="phone-doc-sheet-foot">
                    <button type="button" className="phone-doc-button" data-testid="phone-doc-cancel" onClick={onCancel}>
                        Cancel
                    </button>
                    <a className="phone-doc-button is-primary" href={url} target="_blank" rel="noopener noreferrer" data-testid="phone-doc-link" onClick={onCancel}>
                        <ExternalLink size={14} aria-hidden="true" /> Open link
                    </a>
                </footer>
            </section>
        </>
    )
}
