import React, { useCallback, useEffect, useState } from 'react'
import { Terminal, CheckCircle2, AlertTriangle, Loader2, Bell, MinusCircle } from 'lucide-react'
import {
    DEFAULT_HOOK_INTEGRATION,
    DEFAULT_USAGE_ALERTS,
    HookInstallState,
    HookIntegrationSettings,
    HookTargetState,
    UsageAlertSettings
} from '../../../shared/types'

interface AgentIntegrationSettingsProps {
    hooks?: HookIntegrationSettings
    usageAlerts?: UsageAlertSettings
    onChange: (next: { agentHooks: HookIntegrationSettings; usageAlerts: UsageAlertSettings }) => void
}

function Toggle({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            className={`relative w-11 h-6 rounded-full transition-colors shrink-0 disabled:opacity-40 ${on ? 'bg-blue-600' : 'bg-white/20'}`}
        >
            <div className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`} />
        </button>
    )
}

/** Renders what is actually on disk, including the command we are chaining to. */
function TargetStatus({ state }: { state?: HookTargetState }) {
    if (!state) return null

    // A skipped target is reported before an error is even considered: it is a
    // description of the machine, not a fault, and must not look like one.
    if (state.skipped) {
        return (
            <p className="text-[11px] text-gray-500 mt-1 flex items-start gap-1">
                <MinusCircle size={11} className="mt-0.5 shrink-0" />
                <span>{state.skipReason ?? 'Not applicable on this machine'}</span>
            </p>
        )
    }

    if (state.error) {
        return (
            <p className="text-[11px] text-amber-400 mt-1 flex items-start gap-1">
                <AlertTriangle size={11} className="mt-0.5 shrink-0" />
                <span>{state.error}</span>
            </p>
        )
    }

    if (!state.installed) return null

    return (
        <p className="text-[11px] text-green-400 mt-1 flex items-start gap-1">
            <CheckCircle2 size={11} className="mt-0.5 shrink-0" />
            <span>
                Connected
                {state.wrapped && (
                    <span className="text-gray-500"> · chaining to your existing command ({state.wrapped.slice(0, 60)})</span>
                )}
            </span>
        </p>
    )
}

function ThresholdRow({
    label,
    hint,
    value,
    onChange
}: {
    label: string
    hint: string
    value: number
    onChange: (next: number) => void
}) {
    return (
        <div className="flex items-center justify-between gap-4 py-2">
            <div className="min-w-0">
                <p className="text-sm text-gray-300">{label}</p>
                <p className="text-xs text-gray-500 mt-0.5">{hint}</p>
            </div>
            <div className="flex items-center gap-2 shrink-0">
                <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={value}
                    onChange={(e) => onChange(Number(e.target.value))}
                    className="w-32 accent-blue-500"
                />
                <span className={`text-xs font-mono w-10 text-right ${value === 0 ? 'text-gray-600' : 'text-gray-300'}`}>
                    {value === 0 ? 'off' : `${value}%`}
                </span>
            </div>
        </div>
    )
}

/**
 * Settings for the official CLI integrations.
 *
 * This is opt-in and stays opt-in: turning it on edits files the user owns
 * (`~/.claude/settings.json`, `~/.codex/config.toml`). The panel therefore
 * always shows the verified on-disk state rather than what we intended to
 * write, and names any command we are chaining to so nothing looks lost.
 */
export function AgentIntegrationSettings({ hooks, usageAlerts, onChange }: AgentIntegrationSettingsProps) {
    const current = { ...DEFAULT_HOOK_INTEGRATION, ...(hooks ?? {}) }
    const alerts = { ...DEFAULT_USAGE_ALERTS, ...(usageAlerts ?? {}) }

    const [installState, setInstallState] = useState<HookInstallState | null>(null)
    const [busy, setBusy] = useState(false)

    const refresh = useCallback(async () => {
        try {
            setInstallState(await window.api.getHookState())
        } catch (error) {
            console.error('Failed to read hook state:', error)
        }
    }, [])

    useEffect(() => {
        void refresh()
    }, [refresh])

    /**
     * Applies a change immediately rather than on a Save button: installing
     * writes to disk, and the verified result is the only honest confirmation
     * we can show.
     */
    const apply = async (next: HookIntegrationSettings) => {
        setBusy(true)
        try {
            const result = await window.api.setHookIntegration(next)
            if (result.success && result.data) setInstallState(result.data)
            else await refresh()
            onChange({ agentHooks: next, usageAlerts: alerts })
        } finally {
            setBusy(false)
        }
    }

    const updateAlerts = async (next: UsageAlertSettings) => {
        await window.api.setUsageAlerts(next)
        onChange({ agentHooks: current, usageAlerts: next })
    }

    return (
        <>
            <div>
                <h3 className="text-sm font-semibold text-white mb-1">Official Agent Hooks</h3>
                <p className="text-xs text-gray-400 mb-4">
                    Read session status and usage straight from Claude Code and Codex instead of guessing from
                    terminal output. Your existing hooks and status line keep running — CLI Manager chains to them.
                </p>

                <div className="flex items-center justify-between">
                    <div>
                        <p className="text-sm text-gray-300">Enable Official Integration</p>
                        <p className="text-xs text-gray-500 mt-1">
                            Edits <code className="text-gray-400">~/.claude/settings.json</code> and{' '}
                            <code className="text-gray-400">~/.codex/config.toml</code>. Turning this off restores them.
                        </p>
                    </div>
                    <div className="flex items-center gap-2">
                        {busy && <Loader2 size={14} className="text-gray-400 animate-spin" />}
                        <Toggle on={current.enabled} disabled={busy} onClick={() => void apply({ ...current, enabled: !current.enabled })} />
                    </div>
                </div>

                {current.enabled && (
                    <div className="mt-6 pt-4 border-t border-white/10 space-y-4">
                        <h4 className="text-sm font-medium text-white flex items-center gap-2">
                            <Terminal size={14} className="text-blue-400" />
                            Connections
                        </h4>

                        <div>
                            <div className="flex items-center justify-between">
                                <div className="min-w-0 pr-4">
                                    <p className="text-sm text-gray-300">Claude Code — session events</p>
                                    <p className="text-xs text-gray-500 mt-0.5">
                                        Exact running / finished / waiting-for-approval status, including for the tab you are viewing.
                                    </p>
                                </div>
                                <Toggle
                                    on={current.claudeHooks}
                                    disabled={busy}
                                    onClick={() => void apply({ ...current, claudeHooks: !current.claudeHooks })}
                                />
                            </div>
                            {current.claudeHooks && <TargetStatus state={installState?.claudeHooks} />}
                        </div>

                        <div>
                            <div className="flex items-center justify-between">
                                <div className="min-w-0 pr-4">
                                    <p className="text-sm text-gray-300">Claude Code — usage</p>
                                    <p className="text-xs text-gray-500 mt-0.5">
                                        Official 5-hour and weekly limits. Claude Code exposes these only through the status
                                        line, so enabling this sets one — subscription plans only.
                                    </p>
                                </div>
                                <Toggle
                                    on={current.claudeStatusLine}
                                    disabled={busy}
                                    onClick={() => void apply({ ...current, claudeStatusLine: !current.claudeStatusLine })}
                                />
                            </div>
                            {current.claudeStatusLine && <TargetStatus state={installState?.claudeStatusLine} />}
                        </div>

                        <div>
                            <div className="flex items-center justify-between">
                                <div className="min-w-0 pr-4">
                                    <p className="text-sm text-gray-300">Codex — turn completion</p>
                                    <p className="text-xs text-gray-500 mt-0.5">
                                        Codex only reports when a turn finishes; the start of a turn is still detected from your
                                        typing. Codex usage is read from its session files and needs no hook.
                                    </p>
                                </div>
                                <Toggle
                                    on={current.codexNotify}
                                    disabled={busy}
                                    onClick={() => void apply({ ...current, codexNotify: !current.codexNotify })}
                                />
                            </div>
                            {current.codexNotify && <TargetStatus state={installState?.codexNotify} />}
                        </div>

                        <p className="text-[11px] text-gray-500 pt-2">
                            Sessions without hooks keep using the existing output-based detection, so nothing stops working
                            if a connection fails.
                        </p>
                    </div>
                )}
            </div>

            <div className="mt-8 pt-6 border-t border-white/10">
                <h3 className="text-sm font-semibold text-white mb-1 flex items-center gap-2">
                    <Bell size={14} className="text-amber-400" />
                    Usage Alerts
                </h3>
                <p className="text-xs text-gray-400 mb-3">
                    Get a desktop notification before a limit cuts your agents off. Fires once per window and re-arms
                    when the window resets. Set to 0 to disable a tool.
                </p>

                <div className="flex items-center justify-between py-2 border-b border-white/5">
                    <p className="text-sm text-gray-300">Enable usage alerts</p>
                    <Toggle on={alerts.enabled} onClick={() => void updateAlerts({ ...alerts, enabled: !alerts.enabled })} />
                </div>

                {alerts.enabled && (
                    <div className="divide-y divide-white/5">
                        <ThresholdRow
                            label="Claude Code"
                            hint="Alerts on whichever of the 5-hour or weekly windows crosses first"
                            value={alerts.claudeThresholdPercent}
                            onChange={(value) => void updateAlerts({ ...alerts, claudeThresholdPercent: value })}
                        />
                        <ThresholdRow
                            label="Codex"
                            hint="Weekly window"
                            value={alerts.codexThresholdPercent}
                            onChange={(value) => void updateAlerts({ ...alerts, codexThresholdPercent: value })}
                        />
                    </div>
                )}

                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded mt-4">
                    <p className="text-xs text-blue-200">
                        <strong>Tip:</strong> Claude Code reports usage only after a session's first response, and only on
                        subscription plans. Codex usage appears as soon as a session file exists.
                    </p>
                </div>
            </div>
        </>
    )
}
