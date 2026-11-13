import { useEffect, useRef, useState } from 'react'
import { Check, X } from 'lucide-react'
import { PHONE_API, type PhoneRenameResponse } from '../../../shared/phone'
import { PhoneApiError, postJson } from './api'

/** the Mac's limit (ControlApiService MAX_NAME_LENGTH) */
const MAX_NAME_LENGTH = 80

/**
 * Renames the session from the phone (0a4bdfff): a bar under the header, the name in a box —
 * or, `inline`, in the session list's row a long press opened (ebf8dec6).
 * The Mac renames it as the Control API does, so the sidebar follows at once; the bar hands back the
 * name the Mac kept, shown until the list catches up.
 */
export function PhoneRenameBar({
    sessionId,
    name,
    inline = false,
    onDone,
    onCancel
}: {
    sessionId: string
    name: string
    inline?: boolean
    onDone: (kept: string) => void
    onCancel: () => void
}) {
    const [draft, setDraft] = useState(name)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const box = useRef<HTMLInputElement>(null)

    useEffect(() => {
        box.current?.focus()
        box.current?.select()
    }, [])

    const trimmed = draft.trim()
    const save = async (): Promise<void> => {
        if (saving) return
        if (!trimmed || trimmed === name) {
            onCancel()
            return
        }
        setSaving(true)
        setError(null)
        try {
            const reply = await postJson<PhoneRenameResponse>(`${PHONE_API.rename}/${encodeURIComponent(sessionId)}`, { name: trimmed })
            onDone(reply.name)
        } catch (failure) {
            setSaving(false)
            setError(failure instanceof PhoneApiError && failure.status === 404 ? 'This session is gone on the Mac.' : "Couldn't rename it — the Mac did not answer.")
        }
    }

    return (
        <form
            className={inline ? 'phone-rename phone-rename-inline' : 'phone-rename'}
            data-testid="phone-rename-bar"
            onSubmit={(event) => {
                event.preventDefault()
                void save()
            }}
        >
            <input
                ref={box}
                className="phone-rename-input"
                data-testid="phone-rename-input"
                aria-label="Session name"
                value={draft}
                maxLength={MAX_NAME_LENGTH}
                enterKeyHint="done"
                disabled={saving}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape') onCancel()
                }}
            />
            <button type="submit" className="phone-icon-button" aria-label="Save name" data-testid="phone-rename-save" disabled={saving || !trimmed}>
                <Check size={17} />
            </button>
            <button type="button" className="phone-icon-button" aria-label="Cancel" data-testid="phone-rename-cancel" onClick={onCancel}>
                <X size={17} />
            </button>
            {error && (
                <p className="phone-rename-error" role="alert" data-testid="phone-rename-error">
                    {error}
                </p>
            )}
        </form>
    )
}
