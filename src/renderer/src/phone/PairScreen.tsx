import { useState } from 'react'
import { Lock, Smartphone } from 'lucide-react'
import type { PhoneRefusal } from '../../../shared/phone'
import { pair } from './api'

/**
 * Who this page is not let in as, and — when a code can fix that — the six-digit box.
 * The code is shown on the Mac in Settings › Phone and lives ten minutes.
 */

const REASONS: Record<PhoneRefusal, string> = {
    pairing_required: 'This phone is not signed in to the Mac’s Tailscale account. Enter the code from the Mac to pair it.',
    disabled: 'The phone connection is off on the Mac. Turn it on in CLI Manager › Settings › Phone.',
    funnel: 'This address is open to the internet through Tailscale Funnel. CLI Manager refuses it — use `tailscale serve` instead.',
    not_local: 'This request did not come through the Mac.',
    bad_origin: 'This page was opened from another site.'
}

function defaultLabel(): string {
    const ua = navigator.userAgent
    if (/iPhone/.test(ua)) return 'iPhone'
    if (/iPad/.test(ua)) return 'iPad'
    if (/Android/.test(ua)) return 'Android phone'
    return 'Browser'
}

export function PairScreen({ reason, onPaired }: { reason: PhoneRefusal; onPaired: () => void }) {
    const [code, setCode] = useState('')
    const [label, setLabel] = useState(defaultLabel)
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)

    const submit = async (): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            const result = await pair(code, label)
            if (result.status === 'paired') onPaired()
            else setError(result.reason === 'wrong_code' ? 'That code is not the one on the Mac.' : result.reason === 'no_code' ? 'No code is waiting. Show a new one on the Mac.' : 'The phone connection is off on the Mac.')
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="phone-pair" data-testid="phone-pair">
            <div className="phone-pair-card">
                <div className="phone-pair-icon">{reason === 'pairing_required' ? <Smartphone size={22} /> : <Lock size={22} />}</div>
                <h1>CLI Manager</h1>
                <p data-testid="phone-pair-reason">{REASONS[reason]}</p>
                {reason === 'pairing_required' && (
                    <form
                        onSubmit={(event) => {
                            event.preventDefault()
                            void submit()
                        }}
                    >
                        <label>
                            <span>Code</span>
                            <input
                                data-testid="phone-pair-code"
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                maxLength={7}
                                value={code}
                                onChange={(event) => setCode(event.target.value.replace(/[^\d ]/g, ''))}
                                placeholder="123 456"
                            />
                        </label>
                        <label>
                            <span>This device</span>
                            <input data-testid="phone-pair-label" value={label} maxLength={48} onChange={(event) => setLabel(event.target.value)} />
                        </label>
                        {error && <div className="phone-pair-error" role="alert" data-testid="phone-pair-error">{error}</div>}
                        <button type="submit" disabled={busy || code.replace(/\D/g, '').length !== 6} data-testid="phone-pair-submit">
                            Pair
                        </button>
                    </form>
                )}
            </div>
        </div>
    )
}
