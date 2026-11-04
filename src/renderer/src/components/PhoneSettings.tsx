import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Bell, CheckCircle2, Copy, Check, Loader2, Smartphone, Trash2 } from 'lucide-react'
import qrcode from 'qrcode-generator'
import type { PhoneState } from '../../../shared/types'
import { usePhoneState } from '../hooks/usePhoneState'

/**
 * Settings › Phone. One switch: on starts a small server on 127.0.0.1 for the phone page,
 * off closes it and cuts every phone off. The app never runs `tailscale serve` — it shows
 * the command (and the one that undoes it) for the person to run, then the phone address
 * as a QR code. Phones signed in to this Mac's Tailscale account get in; others pair with
 * a six-digit code shown here.
 */

const COPIED_MS = 1500

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            data-testid="phone-toggle"
            aria-pressed={on}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40 ${on ? 'bg-emerald-600' : 'bg-white/20'}`}
        >
            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
    )
}

function CommandLine({ text, testId }: { text: string; testId: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <div className="flex items-start gap-2">
            <code className="flex-1 block text-[11px] text-gray-300 font-mono break-all bg-black/30 rounded p-2" data-testid={testId}>{text}</code>
            <button
                onClick={async () => {
                    await navigator.clipboard.writeText(text)
                    setCopied(true)
                    setTimeout(() => setCopied(false), COPIED_MS)
                }}
                className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 bg-white/5 hover:bg-white/10 rounded shrink-0"
            >
                {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                {copied ? 'Copied' : 'Copy'}
            </button>
        </div>
    )
}

function Qr({ text }: { text: string }) {
    const src = useMemo(() => {
        const qr = qrcode(0, 'M')
        qr.addData(text)
        qr.make()
        return qr.createDataURL(4, 2)
    }, [text])
    return <img src={src} alt={`QR code for ${text}`} className="w-32 h-32 rounded bg-white p-1 [image-rendering:pixelated]" data-testid="phone-qr" />
}

function minutesLeft(iso: string): number {
    return Math.max(0, Math.ceil((new Date(iso).getTime() - Date.now()) / 60_000))
}

export function PhoneSettings({ onEnabledChange }: { onEnabledChange: (enabled: boolean) => void }) {
    const [state, setState] = usePhoneState()
    const [busy, setBusy] = useState(false)
    const [pushResult, setPushResult] = useState<string | null>(null)
    const [, tick] = useState(0)

    // the code's minutes count down while it shows
    useEffect(() => {
        if (!state?.pairing) return
        const timer = setInterval(() => tick((n) => n + 1), 15_000)
        return () => clearInterval(timer)
    }, [state?.pairing])

    const run = async (action: () => Promise<PhoneState>): Promise<void> => {
        setBusy(true)
        try {
            const next = await action()
            setState(next)
            return
        } finally {
            setBusy(false)
        }
    }

    const on = state?.running ?? false
    const toggle = (): void => {
        void run(async () => {
            const next = await window.api.setPhoneEnabled(!on)
            onEnabledChange(next.running)
            return next
        })
    }

    return (
        <div className="mb-8" data-testid="phone-settings">
            <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
                <Smartphone size={14} className="text-emerald-400" />
                Phone
            </h3>
            <p className="text-xs text-gray-400 mb-4">
                See this Mac’s sessions on your phone — their chat and their terminal — answer questions and type, and get
                an alert when an agent needs you. The phone reaches the Mac over Tailscale; nothing is opened to the internet.
            </p>

            <div className="flex items-center justify-between gap-4">
                <div>
                    <p className="text-sm text-gray-300">Phone connection</p>
                    <p className="text-xs text-gray-500 mt-1">
                        Off by default. On: a small server on 127.0.0.1 only, apart from the AI Control API. Off: it closes and
                        every phone is cut off. Quitting the app turns it off too.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {busy && <Loader2 size={14} className="text-gray-400 animate-spin" />}
                    <Toggle on={on} disabled={busy || state === null} onClick={toggle} />
                </div>
            </div>

            {state?.error && (
                <p className="mt-3 text-[11px] text-amber-400 flex items-start gap-1" data-testid="phone-error">
                    <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                    <span>{state.error}</span>
                </p>
            )}

            {on && state && (
                <div className="mt-5 space-y-5">
                    <p className="text-[11px] text-emerald-400 flex items-start gap-1" data-testid="phone-listening">
                        <CheckCircle2 size={11} className="mt-0.5 shrink-0" />
                        <span>
                            Listening on <code>{state.localUrl}</code> · {state.connected} connected
                        </span>
                    </p>

                    <div>
                        <p className="text-sm text-gray-300">1. Let the phone reach it — run once in a terminal</p>
                        <p className="text-xs text-gray-500 mt-0.5 mb-1">
                            Tailscale serves it as HTTPS to your own devices only. The app does not run this for you.
                            Never use <code>tailscale funnel</code> — that is the public internet, and the app refuses it.
                        </p>
                        <CommandLine text={state.serveCommand} testId="phone-serve-command" />
                        <p className="text-xs text-gray-500 mt-2 mb-1">To undo it later:</p>
                        <CommandLine text={state.serveOffCommand} testId="phone-serve-off-command" />
                    </div>

                    <div>
                        <p className="text-sm text-gray-300">2. Open it on the phone</p>
                        {state.phoneUrl ? (
                            <div className="flex items-center gap-4 mt-2">
                                <Qr text={state.phoneUrl} />
                                <div className="min-w-0 space-y-1">
                                    <code className="block text-xs text-gray-200 break-all" data-testid="phone-url">{state.phoneUrl}</code>
                                    <p className="text-xs text-gray-500">
                                        Scan with the phone’s camera. On iPhone, then Share → Add to Home Screen — alerts need the
                                        Home Screen app (iOS 16.4+).
                                    </p>
                                    {state.tailscale.owner && (
                                        <p className="text-xs text-gray-500" data-testid="phone-owner">
                                            Phones signed in as <span className="text-gray-300">{state.tailscale.owner}</span> get in without a code.
                                        </p>
                                    )}
                                </div>
                            </div>
                        ) : (
                            <p className="text-xs text-amber-400/90 mt-1" data-testid="phone-no-tailscale">
                                {state.tailscale.found
                                    ? 'Tailscale gives this Mac no MagicDNS name. Turn on MagicDNS and HTTPS in the Tailscale admin console.'
                                    : 'Tailscale was not found on this Mac. Install it on the Mac and the phone, and sign both in to the same account.'}
                            </p>
                        )}
                    </div>

                    <div>
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-gray-300">Pair another device</p>
                            {!state.pairing && (
                                <div className="flex gap-1">
                                    <button
                                        className="px-2 py-1 text-xs text-gray-200 bg-white/5 hover:bg-white/10 rounded"
                                        data-testid="phone-pair-drive"
                                        onClick={() => void run(() => window.api.startPhonePairing('drive'))}
                                    >
                                        Code — can type
                                    </button>
                                    <button
                                        className="px-2 py-1 text-xs text-gray-200 bg-white/5 hover:bg-white/10 rounded"
                                        data-testid="phone-pair-watch"
                                        onClick={() => void run(() => window.api.startPhonePairing('watch'))}
                                    >
                                        Code — view only
                                    </button>
                                </div>
                            )}
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5">
                            For a phone not signed in to this Mac’s Tailscale account. The code works for 10 minutes and 5 tries.
                        </p>
                        {state.pairing && (
                            <div className="mt-2 flex items-center gap-3">
                                <code className="text-2xl tracking-[0.3em] text-white font-mono" data-testid="phone-pair-code-mac">
                                    {state.pairing.code.slice(0, 3)} {state.pairing.code.slice(3)}
                                </code>
                                <span className="text-xs text-gray-400">
                                    {state.pairing.role === 'watch' ? 'view only' : 'can type'} · {minutesLeft(state.pairing.expiresAt)} min left
                                </span>
                                <button className="ml-auto px-2 py-1 text-xs text-gray-300 bg-white/5 hover:bg-white/10 rounded" onClick={() => void run(() => window.api.cancelPhonePairing())}>
                                    Cancel
                                </button>
                            </div>
                        )}
                    </div>

                    <div>
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-gray-300">Paired devices ({state.devices.length})</p>
                            {state.devices.length > 0 && (
                                <button
                                    className="px-2 py-1 text-xs text-red-300 bg-red-500/10 hover:bg-red-500/20 rounded"
                                    data-testid="phone-revoke-all"
                                    onClick={() => void run(() => window.api.revokeAllPhoneDevices())}
                                >
                                    Disconnect all
                                </button>
                            )}
                        </div>
                        {state.devices.length === 0 ? (
                            <p className="text-xs text-gray-500 mt-1">None. Your own phone on Tailscale needs no pairing.</p>
                        ) : (
                            <ul className="mt-2 space-y-1" data-testid="phone-devices">
                                {state.devices.map((device) => (
                                    <li key={device.id} className="flex items-center gap-2 text-xs text-gray-300 bg-white/5 rounded px-2 py-1.5" data-testid="phone-device">
                                        <Smartphone size={12} className="text-gray-500" />
                                        <span className="flex-1 min-w-0 truncate">{device.label}</span>
                                        <span className="text-gray-500">{device.role === 'watch' ? 'view only' : 'can type'}</span>
                                        <span className="text-gray-600">{device.lastSeenAt ? new Date(device.lastSeenAt).toLocaleString() : ''}</span>
                                        <button
                                            className="p-1 text-gray-400 hover:text-red-300 rounded hover:bg-white/10"
                                            title="Disconnect this device now"
                                            data-testid="phone-revoke"
                                            onClick={() => void run(() => window.api.revokePhoneDevice(device.id))}
                                        >
                                            <Trash2 size={12} />
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </div>

                    <div className="flex items-center justify-between gap-2">
                        <div>
                            <p className="text-sm text-gray-300 flex items-center gap-1.5"><Bell size={12} /> Alerts</p>
                            <p className="text-xs text-gray-500 mt-0.5">
                                {state.pushDevices} device{state.pushDevices === 1 ? '' : 's'} turned alerts on (bell on the phone page). A
                                question or a finished turn; never while you use the app here; once a minute per session.
                            </p>
                            {state.pushError && <p className="text-xs text-amber-400 mt-1" data-testid="phone-push-error">{state.pushError}</p>}
                            {pushResult && <p className="text-xs text-blue-300 mt-1" data-testid="phone-push-result">{pushResult}</p>}
                        </div>
                        <button
                            className="px-2 py-1 text-xs text-gray-200 bg-white/5 hover:bg-white/10 rounded shrink-0"
                            data-testid="phone-test-push"
                            onClick={async () => {
                                const result = await window.api.testPhonePush()
                                setPushResult(result.status === 'sent' ? `Sent to ${result.devices} device${result.devices === 1 ? '' : 's'}.` : result.message)
                            }}
                        >
                            Send a test alert
                        </button>
                    </div>
                </div>
            )}
        </div>
    )
}
