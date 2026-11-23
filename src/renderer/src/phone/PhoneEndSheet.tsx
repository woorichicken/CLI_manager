import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PHONE_API, type PhoneEndResponse, type PhoneSession } from '../../../shared/phone'
import { PhoneApiError, postJson } from './api'

/**
 * The question before the phone ends a session (f683eafe r2): the session's name, what happens,
 * Cancel focused — a tap that only meant to close the menu lands on Cancel, Escape and the scrim too.
 * End asks the Mac to close it the way the sidebar and the Control API do (POST /api/phone/end).
 * Drawn over the whole page (a portal): the drawer it opens from may be transformed or clipped.
 */
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
    const [ending, setEnding] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        cancel.current?.focus()
        const key = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') onCancel()
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
            if (failure instanceof PhoneApiError && failure.status === 404) setError('This session is already gone on the Mac.')
            else if (failure instanceof PhoneApiError && failure.status === 403) setError('This device can only watch.')
            else setError("Couldn't end it — the Mac did not answer.")
        }
    }

    return createPortal(
        <div className="phone-end-layer">
            <div className="phone-end-scrim" aria-hidden="true" onClick={onCancel} />
            <section className="phone-end-sheet" role="alertdialog" aria-modal="true" aria-labelledby="phone-end-title" aria-describedby="phone-end-note" data-testid="phone-end-sheet">
                <h2 id="phone-end-title" className="phone-end-title">
                    End <strong>{session.name}</strong>?
                </h2>
                <p id="phone-end-note" className="phone-end-note">
                    The terminal closes and the session leaves the list.
                </p>
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
