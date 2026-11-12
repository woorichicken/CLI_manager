import { useCallback, useEffect, useState } from 'react'
import { Gauge, RefreshCw, X } from 'lucide-react'
import { PHONE_API, type PhoneUsageResponse, type PhoneUsageWindow } from '../../../shared/phone'
import { getJson } from './api'
import { untilReset } from './usageText'
import './phone-dock.css'

/** at or past this, a bar turns amber; the app's usage alerts default to 80 too */
const WARN_PERCENT = 80

function Bar({ label, window, testId }: { label: string; window?: PhoneUsageWindow; testId: string }) {
    if (!window) return null
    const used = Math.max(0, Math.min(100, Math.round(window.usedPercent)))
    const reset = untilReset(window.resetsAt)
    return (
        <div className="phone-usage-bar" data-testid={testId} data-used={used}>
            <span className="phone-usage-bar-label">{label}</span>
            <span className="phone-usage-track" aria-hidden="true">
                <span className={`phone-usage-fill${used >= WARN_PERCENT ? ' is-warn' : ''}`} style={{ width: `${used}%` }} />
            </span>
            <span className="phone-usage-pct">{used}%</span>
            {reset && <span className="phone-usage-reset">resets {reset}</span>}
        </div>
    )
}

/**
 * What the agents have used (3b4efdfc), read-only: the app's own reading of Claude Code and Codex,
 * and agent-swap's accounts when the Mac has it. Read when it opens; ↻ reads again (the Mac keeps
 * agent-swap's answer a minute).
 */
export function PhoneUsagePanel({ onClose }: { onClose: () => void }) {
    const [data, setData] = useState<PhoneUsageResponse | null>(null)
    const [failed, setFailed] = useState(false)
    const [loading, setLoading] = useState(false)

    const load = useCallback(() => {
        setLoading(true)
        setFailed(false)
        getJson<PhoneUsageResponse>(PHONE_API.usage)
            .then((body) => setData(body))
            .catch(() => setFailed(true))
            .finally(() => setLoading(false))
    }, [])
    useEffect(() => load(), [load])

    const app = data?.app
    const swap = data?.agentSwap ?? null
    const nothing = data !== null && !app?.claude && !app?.codex && !swap

    return (
        <section className="phone-dock-panel phone-usage-panel" data-testid="phone-usage-panel" aria-label="Usage">
            <header className="phone-dock-head">
                <Gauge size={16} aria-hidden="true" />
                <span className="phone-dock-title">Usage</span>
                <span className="phone-dock-order">{loading ? 'Reading…' : ''}</span>
                <button type="button" className="phone-icon-button" aria-label="Read again" data-testid="phone-usage-refresh" onClick={load} disabled={loading}>
                    <RefreshCw size={16} />
                </button>
                <button type="button" className="phone-icon-button" aria-label="Close usage" data-testid="phone-usage-close" onClick={onClose}>
                    <X size={18} />
                </button>
            </header>
            {failed && <div className="phone-dock-status">Couldn't read usage from the Mac.</div>}
            <div className="phone-dock-list">
                {data === null && !failed && <p className="phone-usage-note">Reading…</p>}
                {nothing && <p className="phone-usage-note">No usage yet — it shows after Claude Code or Codex runs on the Mac.</p>}
                {app?.claude && (app.claude.fiveHour || app.claude.sevenDay) && (
                    <div className="phone-usage-group" data-testid="phone-usage-claude">
                        <div className="phone-dock-section-title">Claude Code</div>
                        <Bar label="5h" window={app.claude.fiveHour} testId="phone-usage-claude-5h" />
                        <Bar label="7d" window={app.claude.sevenDay} testId="phone-usage-claude-7d" />
                    </div>
                )}
                {app?.codex?.weekly && (
                    <div className="phone-usage-group" data-testid="phone-usage-codex">
                        <div className="phone-dock-section-title">Codex</div>
                        <Bar label="7d" window={app.codex.weekly} testId="phone-usage-codex-7d" />
                    </div>
                )}
                {swap && (
                    <div className="phone-usage-group" data-testid="phone-usage-agent-swap">
                        <div className="phone-dock-section-title">agent-swap accounts</div>
                        {swap.accounts.length === 0 && <p className="phone-usage-note">No accounts saved in agent-swap.</p>}
                        {swap.accounts.map((account, index) => (
                            <div key={`${account.label}-${index}`} className="phone-usage-account" data-testid="phone-usage-account" data-active={account.active ? 'true' : undefined}>
                                <div className="phone-usage-account-head">
                                    <span className="phone-usage-account-label">{account.label}</span>
                                    {account.active && <span className="phone-usage-badge">active</span>}
                                    {account.status !== 'ok' && <span className="phone-usage-badge is-dim">{account.status.replace(/_/g, ' ')}</span>}
                                </div>
                                <Bar label="5h" window={account.fiveHour} testId="phone-usage-account-5h" />
                                <Bar label="7d" window={account.sevenDay} testId="phone-usage-account-7d" />
                                {account.sevenDay?.willLastToReset === false && account.sevenDay.projectedExhaustionAt && (
                                    <p className="phone-usage-warn" data-testid="phone-usage-runs-out">Runs out {untilReset(account.sevenDay.projectedExhaustionAt)} at this pace</p>
                                )}
                            </div>
                        ))}
                        {swap.codex && (
                            <div className="phone-usage-account">
                                <div className="phone-usage-account-head">
                                    <span className="phone-usage-account-label">Codex (agent-swap)</span>
                                </div>
                                {/* which slot is weekly differs by plan (CLAUDE.md, agent hooks 6) and agent-swap does not say the window: numbered, with when each resets */}
                                <Bar label="#1" window={swap.codex.primary} testId="phone-usage-swap-codex-primary" />
                                <Bar label="#2" window={swap.codex.secondary} testId="phone-usage-swap-codex-secondary" />
                            </div>
                        )}
                    </div>
                )}
            </div>
        </section>
    )
}
