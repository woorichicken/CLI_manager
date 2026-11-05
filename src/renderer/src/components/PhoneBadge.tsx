import { useState } from 'react'
import { Smartphone, X } from 'lucide-react'
import { usePhoneState } from '../hooks/usePhoneState'

/**
 * At the bottom of the sidebar while the phone connection is on: «Phone on · n connected»,
 * so a Mac acting as a server is never forgotten, and one click to switch it off (the
 * server closes, every phone is cut off). Clicking the text opens Settings › Phone.
 */
export function PhoneBadge({ onOpenSettings }: { onOpenSettings: () => void }) {
    const [state, setState] = usePhoneState()
    const [busy, setBusy] = useState(false)
    if (!state?.running) return null
    const connected = state.connected
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
                onClick={async () => {
                    setBusy(true)
                    try {
                        setState(await window.api.setPhoneEnabled(false))
                    } finally {
                        setBusy(false)
                    }
                }}
            >
                <X size={13} />
            </button>
        </div>
    )
}
