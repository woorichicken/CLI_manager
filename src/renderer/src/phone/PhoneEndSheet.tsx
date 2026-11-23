import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PHONE_API, type PhoneEndResponse, type PhoneSession } from '../../../shared/phone'
import { PhoneApiError, postJson } from './api'

/**
 * The question before the phone ends a session (f683eafe r2): the session's name, what happens,
 * Cancel focused — a tap that only meant to close the menu lands on Cancel, Escape and the scrim too.
 * End asks the Mac to close it the way the Control API does (POST /api/phone/end). The Mac's own
 * close asks «Terminate running processes?» from the process list; the phone has the list's state
 * instead, so a session at work or waiting for an answer says so in one more line.
 * Drawn over the whole page (a portal): the drawer it opens from may be transformed or clipped.
 */

/** What ending interrupts, from the state the list shows; null when nothing is going on. */
export function endWarning(session: Pick<PhoneSession, 'agent' | 'state'>): string | null {
    const who = session.agent === 'claude' ? 'Claude' : session.agent === 'codex' ? 'Codex' : null
    if (session.state === 'waiting') return `${who ?? 'The session'} is waiting for your answer — ending drops the question.`
    if (session.state === 'working') return who ? `${who} is still working — it will be stopped.` : 'Something is still running — it will be stopped.'
    return null
}
export function PhoneEndSheet({
    session,
    onCancel,
    onEnded
}: {
    session: PhoneSession
    onCancel: () => void
    /** the Mac closed it: the list can drop the row before its next read */
    onEnded: (id: string) => void
}) {
    const cancel = useRef<HTMLButtonElement>(null)
    const sheet = useRef<HTMLElement>(null)
    const [ending, setEnding] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const warning = endWarning(session)

    useEffect(() => {
        cancel.current?.focus()
        const key = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onCancel()
            // focus stays in the sheet: Tab walks its buttons round (a keyboard on a tablet)
            if (event.key === 'Tab' && sheet.current) {
                const buttons = Array.from(sheet.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
                if (buttons.length === 0) return
                const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
                const next = event.shiftKey ? (at <= 0 ? buttons.length - 1 : at - 1) : (at < 0 || at === buttons.length - 1 ? 0 : at + 1)
                event.preventDefault()
                buttons[next].focus()
            }
        }
        document.addEventListener('keydown', key)
        return () => document.removeEventListener('keydown', key)
    }, [onCancel])

    const end = async (): Promise<void> => {
        if (ending) return
        setEnding(true)
        setError(null)
        try {
            await postJson<PhoneEndResponse>(`${PHONE_API.end}/${encodeURIComponent(session.id)}`, {})
            onEnded(session.id)
        } catch (failure) {
            setEnding(false)
            // already closed on the Mac (or from another phone): the row goes, as if this End did it
            if (failure instanceof PhoneApiError && failure.status === 404) onEnded(session.id)
            else if (failure instanceof PhoneApiError && failure.status === 403) setError('This device can only watch.')
            else setError("Couldn't end it — the Mac did not answer.")
        }
    }

    return createPortal(
        <div className="phone-end-layer">
            <div className="phone-end-scrim" aria-hidden="true" onClick={onCancel} />
            <section ref={sheet} className="phone-end-sheet" role="alertdialog" aria-modal="true" aria-labelledby="phone-end-title" aria-describedby="phone-end-note" data-testid="phone-end-sheet">
                <h2 id="phone-end-title" className="phone-end-title">
                    End <strong>{session.name}</strong>?
                </h2>
                <p id="phone-end-note" className="phone-end-note">
                    The terminal closes and the session leaves the list.
                </p>
                {warning && (
                    <p className="phone-end-warning" data-testid="phone-end-warning" data-state={session.state}>
                        {warning}
                    </p>
                )}
                {error && (
                    <p className="phone-end-error" role="alert" data-testid="phone-end-error">
                        {error}
                    </p>
                )}
                <footer className="phone-end-foot">
                    <button ref={cancel} type="button" className="phone-end-button" data-testid="phone-end-cancel" onClick={onCancel}>
                        Cancel
                    </button>
                    <button type="button" className="phone-end-button is-danger" data-testid="phone-end-confirm" disabled={ending} onClick={() => void end()}>
                        {ending ? 'Ending…' : 'End'}
                    </button>
                </footer>
            </section>
        </div>,
        document.body
    )
}
