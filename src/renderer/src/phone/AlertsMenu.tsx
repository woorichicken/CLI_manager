import { useEffect, useRef, useState } from 'react'
import { Bell, BellOff, BellRing } from 'lucide-react'
import { testPush } from './api'
import { alertsState, disableAlerts, enableAlerts, type AlertsState } from './push'

/**
 * Alerts for this phone: on/off and a test. The Mac sends one when a session asks a
 * question or an agent's turn ends — not while someone uses the app at the Mac, and at
 * most once a minute per session.
 */
export function AlertsMenu({ publicKey }: { publicKey: string }) {
    const [open, setOpen] = useState(false)
    const [state, setState] = useState<AlertsState | null>(null)
    const [message, setMessage] = useState<string | null>(null)
    const root = useRef<HTMLDivElement>(null)

    useEffect(() => {
        void alertsState().then(setState).catch(() => setState('unsupported'))
    }, [])

    useEffect(() => {
        if (!open) return
        const close = (event: PointerEvent): void => {
            if (!root.current?.contains(event.target as Node)) setOpen(false)
        }
        document.addEventListener('pointerdown', close)
        return () => document.removeEventListener('pointerdown', close)
    }, [open])

    const run = async (action: () => Promise<AlertsState>): Promise<void> => {
        setMessage(null)
        try {
            setState(await action())
        } catch (error) {
            setMessage(error instanceof Error ? error.message : String(error))
        }
    }

    const test = async (): Promise<void> => {
        setMessage('Sending…')
        const result = await testPush().catch((error) => ({ status: 'failed' as const, message: String(error) }))
        setMessage(result.status === 'sent' ? `Sent to ${result.devices} device${result.devices === 1 ? '' : 's'}.` : result.message)
    }

    const Icon = state === 'on' ? BellRing : state === 'off' || state === null ? Bell : BellOff
    return (
        <div className="phone-alerts" ref={root}>
            <button type="button" className="phone-icon-button" aria-label="Alerts" data-testid="phone-alerts-button" data-state={state ?? ''} onClick={() => setOpen((v) => !v)}>
                <Icon size={17} />
            </button>
            {open && (
                <div className="phone-menu" role="menu" data-testid="phone-alerts-menu">
                    <div className="phone-menu-title">Alerts</div>
                    {state === 'unsupported' && (
                        <p className="phone-menu-note">This browser cannot get alerts. On iPhone: Share → Add to Home Screen, then open CLI Manager from there (iOS 16.4+).</p>
                    )}
                    {state === 'denied' && <p className="phone-menu-note">Notifications are blocked for this page. Allow them in the phone’s settings.</p>}
                    {state === 'off' && (
                        <button type="button" role="menuitem" data-testid="phone-alerts-on" onClick={() => void run(() => enableAlerts(publicKey))}>
                            Turn alerts on
                        </button>
                    )}
                    {state === 'on' && (
                        <button type="button" role="menuitem" data-testid="phone-alerts-off" onClick={() => void run(disableAlerts)}>
                            Turn alerts off
                        </button>
                    )}
                    <button type="button" role="menuitem" data-testid="phone-alerts-test" onClick={() => void test()}>
                        Send a test alert
                    </button>
                    <p className="phone-menu-note">A question or a finished turn. Not while you use the app on the Mac; once a minute per session.</p>
                    {message && <p className="phone-menu-result" data-testid="phone-alerts-result">{message}</p>}
                </div>
            )}
        </div>
    )
}
