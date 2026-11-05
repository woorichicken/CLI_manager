import { useEffect } from 'react'
import { Smartphone } from 'lucide-react'
import type { PhoneConnection, PhoneState } from '../../../shared/types'

/** A connection with no socket drops out a minute after its last request: read again while shown. */
const REFRESH_MS = 15_000

const ROUTE_LABEL: Record<PhoneConnection['route'], string> = {
    tailscale: 'Tailscale',
    local: 'USB or this Mac'
}

function sinceText(iso: string): string {
    const at = new Date(iso)
    const sameDay = at.toDateString() === new Date().toDateString()
    return sameDay ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : at.toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })
}

/**
 * Settings › Phone: the phones that have the page open now (phone-fixes C-2). The owner's phone
 * over Tailscale is never paired, so «Paired devices (0)» alone read as «nothing connected».
 */
export function PhoneConnectionsList({ state, onState }: { state: PhoneState; onState: (next: PhoneState) => void }) {
    useEffect(() => {
        if (!state.running) return
        const timer = setInterval(() => {
            window.api.getPhoneState().then(onState).catch(() => undefined)
        }, REFRESH_MS)
        return () => clearInterval(timer)
    }, [state.running, onState])

    const connections = state.connections
    return (
        <div data-testid="phone-connections">
            <p className="text-sm text-gray-300">Connected now ({connections.length})</p>
            {connections.length === 0 ? (
                <p className="text-xs text-gray-500 mt-1">No phone has the page open.</p>
            ) : (
                <ul className="mt-2 space-y-1">
                    {connections.map((connection) => (
                        <li
                            key={connection.key}
                            className="flex items-center gap-2 text-xs text-gray-300 bg-white/5 rounded px-2 py-1.5"
                            data-testid="phone-connection"
                            data-route={connection.route}
                            data-kind={connection.kind}
                        >
                            <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${connection.live ? 'bg-emerald-400' : 'bg-gray-500'}`}
                                title={connection.live ? 'A chat or terminal is open' : 'Opened the page in the last minute'}
                            />
                            <Smartphone size={12} className="text-gray-500 shrink-0" />
                            <span className="min-w-0 truncate" data-testid="phone-connection-label">
                                {connection.label}
                                {connection.kind === 'owner' && <span className="text-gray-500" title="This Mac’s Tailscale account"> (you)</span>}
                            </span>
                            <span className="ml-auto shrink-0 px-1.5 py-0.5 rounded bg-white/5 text-gray-400" data-testid="phone-connection-route">
                                {ROUTE_LABEL[connection.route]}
                            </span>
                            {connection.browser && <span className="shrink-0 text-gray-500 hidden sm:inline">{connection.browser}</span>}
                            {connection.role === 'watch' && <span className="shrink-0 text-gray-500">view only</span>}
                            <span className="shrink-0 text-gray-600" title={`Connected ${new Date(connection.since).toLocaleString()}`}>
                                since {sinceText(connection.since)}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    )
}
