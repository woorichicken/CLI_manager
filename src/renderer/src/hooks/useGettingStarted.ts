import { useCallback, useEffect, useState } from 'react'
import { gettingStartedVisible, type GettingStartedState } from '../../../shared/gettingStarted'

/** How often main looks again while the card is up — it stops once the card is gone. */
const CHECK_INTERVAL_MS = 3_000

/**
 * The Getting started card's state (main window only). Main decides what is done from the app's
 * real state; this asks it on a short timer while the card is shown, and at once when `nudge`
 * changes (a folder or session was added). A closed or finished card costs nothing.
 */
export function useGettingStarted(enabled: boolean, nudge: unknown) {
    const [state, setState] = useState<GettingStartedState | null>(null)
    const visible = enabled && gettingStartedVisible(state)

    useEffect(() => {
        if (!enabled) return
        let alive = true
        window.api.gettingStartedGet().then((value) => { if (alive) setState(value) }).catch(() => {})
        return () => { alive = false }
    }, [enabled])

    useEffect(() => {
        if (!visible) return
        let alive = true
        const check = (): void => {
            window.api.gettingStartedCheck().then((value) => { if (alive) setState(value) }).catch(() => {})
        }
        check()
        const timer = window.setInterval(check, CHECK_INTERVAL_MS)
        return () => {
            alive = false
            window.clearInterval(timer)
        }
    }, [visible, nudge])

    /** The welcome screen was accepted: show the card (again). */
    const begin = useCallback(async () => {
        try { setState(await window.api.gettingStartedBegin()) } catch { /* the card simply stays hidden */ }
    }, [])

    const dismiss = useCallback(async () => {
        setState((prev) => prev ? { ...prev, dismissed: true } : prev)
        try { setState(await window.api.gettingStartedDismiss()) } catch { /* hidden already */ }
    }, [])

    /** Looks again now (after a button changed something the card shows), without waiting for the timer. */
    const refresh = useCallback(async () => {
        try { setState(await window.api.gettingStartedCheck()) } catch { /* the next timer tick tries again */ }
    }, [])

    return { state: visible ? state : null, begin, dismiss, refresh }
}
