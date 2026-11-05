import { useCallback, useState } from 'react'
import { Smartphone, X } from 'lucide-react'
import { usePhoneState } from '../hooks/usePhoneState'
import { ConfirmationModal } from './Sidebar/Modals'

/**
 * At the bottom of the sidebar while the phone connection is on: «Phone on · n connected»,
 * so a Mac acting as a server is never forgotten. The ✕ switches it off (the server closes,
 * every phone is cut off) — after a confirmation, because the ✕ sits where the pointer
 * passes on its way to the sidebar and one stray click looked like the phone connection
 * «dropping by itself». Clicking the text opens Settings › Phone, whose switch needs no
 * confirmation (going there is already deliberate).
 */
export function PhoneBadge({ onOpenSettings }: { onOpenSettings: () => void }) {
    const [state, setState] = usePhoneState()
    const [busy, setBusy] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const cancel = useCallback(() => setConfirming(false), [])
    if (!state?.running) return null
    const connected = state.connected
    const turnOff = async () => {
        setConfirming(false)
        setBusy(true)
        try {
            setState(await window.api.setPhoneEnabled(false))
        } finally {
            setBusy(false)
        }
    }
    return (
        <div
            className="mx-2 mb-2 flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-1.5 text-xs text-emerald-200 flex-shrink-0 no-drag"
            data-testid="phone-badge"
            data-connected={connected}
        >
            <Smartphone size={13} className="shrink-0 text-emerald-400" />
            <button type="button" className="flex-1 min-w-0 truncate text-left hover:underline" onClick={onOpenSettings} title="Settings › Phone">
                Phone on · {connected} connected
            </button>
            <button
                type="button"
                className="shrink-0 rounded p-0.5 text-emerald-300 hover:bg-white/10 disabled:opacity-40"
                title="Turn the phone connection off — every phone is cut off"
                aria-label="Turn the phone connection off"
                data-testid="phone-badge-off"
                disabled={busy}
                onClick={() => setConfirming(true)}
            >
                <X size={13} />
            </button>
            {confirming && (
                <ConfirmationModal
                    title="Turn the phone connection off?"
                    message={
                        connected === 0
                            ? 'No phone is connected now. Phones cannot reach this Mac until you turn it on again.'
                            : connected === 1
                              ? 'The 1 connected phone will be cut off.'
                              : `All ${connected} connected phones will be cut off.`
                    }
                    confirmText="Turn off"
                    isDangerous
                    dismissible
                    testId="phone-off-confirm"
                    onConfirm={turnOff}
                    onCancel={cancel}
                />
            )}
        </div>
    )
}
