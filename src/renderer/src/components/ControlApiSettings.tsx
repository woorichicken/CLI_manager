import { useCallback, useEffect, useState } from 'react'
import { Bot, CheckCircle2, AlertTriangle, Loader2, Copy, Check, RefreshCw, Eye, EyeOff } from 'lucide-react'
import { ControlApiSettings as ControlApiConfig, ControlApiState, DEFAULT_CONTROL_API } from '../../../shared/types'

interface ControlApiSettingsProps {
    config?: ControlApiConfig
    onChange: (next: ControlApiConfig) => void
}

/** Ports below this need root on macOS; 0 (random) is only for tests. */
const MIN_PORT = 1024
const MAX_PORT = 65535
const COPIED_FEEDBACK_MS = 1500

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40 ${on ? 'bg-emerald-600' : 'bg-white/20'}`}
        >
            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
    )
}

function CopyButton({ text, label }: { text: string; label: string }) {
    const [copied, setCopied] = useState(false)
    return (
        <button
            onClick={async () => {
                await navigator.clipboard.writeText(text)
                setCopied(true)
                setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
            }}
            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 bg-white/5 hover:bg-white/10 rounded transition-colors shrink-0"
            title={label}
        >
            {copied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
            {copied ? 'Copied' : 'Copy'}
        </button>
    )
}

/**
 * Settings for the local API an AI uses to open and drive sessions.
 *
 * Applied immediately (no Save button), like the hook toggle above it: the
 * panel shows the server as it actually is — listening, or why it is not.
 */
export function ControlApiSettings({ config, onChange }: ControlApiSettingsProps) {
    const current = { ...DEFAULT_CONTROL_API, ...(config ?? {}) }
    const [state, setState] = useState<ControlApiState | null>(null)
    const [busy, setBusy] = useState(false)
    const [portDraft, setPortDraft] = useState(String(current.port))
    const [showToken, setShowToken] = useState(false)

    const refresh = useCallback(async () => {
        try {
            setState(await window.api.getControlApiState())
        } catch (error) {
            console.error('Failed to read Control API state:', error)
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    useEffect(() => {
        setPortDraft(String(current.port))
    }, [current.port])

    const apply = async (next: ControlApiConfig) => {
        setBusy(true)
        try {
            setState(await window.api.setControlApi(next))
            onChange(next)
        } finally {
            setBusy(false)
        }
    }

    const commitPort = () => {
        const port = Number(portDraft)
        if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
            setPortDraft(String(current.port))
            return
        }
        if (port !== current.port) void apply({ ...current, port })
    }

    const regenerate = async () => {
        setBusy(true)
        try {
            setState(await window.api.regenerateControlApiToken())
        } finally {
            setBusy(false)
        }
    }

    const token = state?.token ?? ''
    const mcpUrl = state?.mcpUrl ?? `http://127.0.0.1:${current.port}/mcp`
    const claudeCommand = `claude mcp add --scope user --transport http cli-manager ${mcpUrl} --header "Authorization: Bearer ${token}"`

    return (
        <div className="mb-8 pb-6 border-b border-white/10">
            <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
                <Bot size={14} className="text-emerald-400" />
                AI Control API
            </h3>
            <p className="text-xs text-gray-400 mb-4">
                Let an AI (Claude Code, Codex, scripts) open sessions here, run your templates, type prompts and read the
                results — in terminals you can watch and step into. Sessions it opens are shown in green.
            </p>

            <div className="flex items-center justify-between">
                <div>
                    <p className="text-sm text-gray-300">Enable AI Control API</p>
                    <p className="text-xs text-gray-500 mt-1">
                        Local only (127.0.0.1) and token-protected. The AI can only touch sessions it opened.
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    {busy && <Loader2 size={14} className="text-gray-400 animate-spin" />}
                    <Toggle on={current.enabled} disabled={busy} onClick={() => void apply({ ...current, enabled: !current.enabled })} />
                </div>
            </div>

            {current.enabled && (
                <div className="mt-5 space-y-4">
                    {state?.error ? (
                        <p className="text-[11px] text-amber-400 flex items-start gap-1">
                            <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                            <span>{state.error}</span>
                        </p>
                    ) : state?.running ? (
                        <p className="text-[11px] text-emerald-400 flex items-start gap-1">
                            <CheckCircle2 size={11} className="mt-0.5 shrink-0" />
                            <span>Listening on <code>{state.url}</code></span>
                        </p>
                    ) : null}

                    <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0">
                            <p className="text-sm text-gray-300">Port</p>
                            <p className="text-xs text-gray-500 mt-0.5">Changing it means re-running the connect command below.</p>
                        </div>
                        <input
                            type="number"
                            min={MIN_PORT}
                            max={MAX_PORT}
                            value={portDraft}
                            disabled={busy}
                            onChange={(e) => setPortDraft(e.target.value)}
                            onBlur={commitPort}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') commitPort()
                            }}
                            className="w-24 bg-black/30 border border-white/10 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-emerald-500/50"
                        />
                    </div>

                    <div>
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-gray-300">Token</p>
                            <div className="flex items-center gap-1">
                                <button
                                    onClick={() => setShowToken((v) => !v)}
                                    className="p-1 text-gray-400 hover:text-gray-200 rounded hover:bg-white/10"
                                    title={showToken ? 'Hide token' : 'Show token'}
                                >
                                    {showToken ? <EyeOff size={12} /> : <Eye size={12} />}
                                </button>
                                <CopyButton text={token} label="Copy token" />
                                <button
                                    onClick={() => void regenerate()}
                                    disabled={busy}
                                    className="flex items-center gap-1 px-2 py-1 text-xs text-gray-300 bg-white/5 hover:bg-white/10 rounded transition-colors disabled:opacity-40"
                                    title="Issue a new token. Clients using the old one stop working."
                                >
                                    <RefreshCw size={12} />
                                    Regenerate
                                </button>
                            </div>
                        </div>
                        <code className="block mt-1 text-[11px] text-gray-400 font-mono break-all">
                            {showToken ? token : '•'.repeat(Math.min(token.length, 32))}
                        </code>
                    </div>

                    <div>
                        <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-gray-300">Connect Claude Code (MCP)</p>
                            <CopyButton text={claudeCommand} label="Copy command" />
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5 mb-1">
                            Run once in a terminal. Claude Code then gets tools like open_session, send_input and wait_for_idle.
                        </p>
                        <code className="block text-[11px] text-gray-400 font-mono break-all bg-black/30 rounded p-2">
                            {showToken ? claudeCommand : claudeCommand.replace(token, '<token>')}
                        </code>
                    </div>

                    {state?.discoveryPath && (
                        <p className="text-[11px] text-gray-500">
                            Scripts can read the URL and token from <code className="text-gray-400">{state.discoveryPath}</code>{' '}
                            (owner-only, removed when the app quits).
                        </p>
                    )}

                    <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded">
                        <p className="text-xs text-blue-200">
                            <strong>Tip:</strong> Ask your AI something like "open a claude-code session in ~/project and have it
                            fix the failing test". To take a session back, right-click it → Disconnect AI.
                        </p>
                    </div>
                </div>
            )}
        </div>
    )
}
