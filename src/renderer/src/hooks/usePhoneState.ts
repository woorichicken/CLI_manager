import { useEffect, useState } from 'react'
import type { PhoneState } from '../../../shared/types'

/**
 * The phone connection as main reports it (Settings › Phone and the sidebar badge).
 * Read once, then kept by main's `phone-state-changed` broadcasts.
 */
export function usePhoneState(): [PhoneState | null, (next: PhoneState) => void] {
    const [state, setState] = useState<PhoneState | null>(null)
    useEffect(() => {
        let live = true
        window.api.getPhoneState().then((next) => {
            if (live) setState(next)
        }).catch((error) => console.error('[phone] state read failed', error))
        const off = window.api.onPhoneStateChanged((next) => setState(next))
        return () => {
            live = false
            off()
        }
    }, [])
    return [state, setState]
}
