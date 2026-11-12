import { execFile } from 'child_process'
import type { UsageSnapshot, UsageWindow } from '../../shared/types'
import type { PhoneUsageAccount, PhoneUsageResponse, PhoneUsageWindow } from '../../shared/phone'

/**
 * The phone's usage view (3b4efdfc): what the app reads itself, plus agent-swap's accounts when
 * the `aswap` command is installed. agent-swap is the user's own tool, not ours — it is asked
 * only while a phone looks at this view, at most once a minute, and a missing or failing command
 * leaves the app's own numbers.
 */

/** a reading is reused this long: the view is opened, closed, opened again */
export const AGENT_SWAP_CACHE_MS = 60_000
/** `aswap list --json` took 1–2 s on a Mac with two accounts (2026-11-12); a hung command must not hold the view */
export const AGENT_SWAP_TIMEOUT_MS = 10_000
/** the answer is a few KB (3.4 KB with two accounts); anything far larger is not it */
const AGENT_SWAP_MAX_BYTES = 1024 * 1024
/** letters of an email's name kept in view */
const EMAIL_NAME_SHOWN = 2

export type AgentSwapUsage = NonNullable<PhoneUsageResponse['agentSwap']>

/** runs `aswap list --json` and gives its stdout; rejects when it is not installed, fails, or times out */
export type AgentSwapRun = () => Promise<string>

/** `ab…@example.com`: enough to tell two accounts apart, not the address itself */
export function shortenEmail(email: string): string {
    const at = email.lastIndexOf('@')
    if (at <= 0) return email.length > EMAIL_NAME_SHOWN ? `${email.slice(0, EMAIL_NAME_SHOWN)}…` : email
    const name = email.slice(0, at)
    const shown = name.length > EMAIL_NAME_SHOWN ? `${name.slice(0, EMAIL_NAME_SHOWN)}…` : name
    return `${shown}${email.slice(at)}`
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function isoOrNull(value: unknown): string | null {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
    // Codex's windows carry epoch seconds
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return new Date(value * 1000).toISOString()
    return null
}

function windowOf(value: unknown, percentKey: 'pct' | 'usedPercent'): PhoneUsageWindow | undefined {
    if (!isRecord(value)) return undefined
    const used = value[percentKey]
    if (typeof used !== 'number' || !Number.isFinite(used)) return undefined
    return { usedPercent: used, resetsAt: isoOrNull(value.resetsAt) }
}

/**
 * Reads `aswap list --json` (schemaVersion 1). Unknown fields are ignored and a row it cannot read
 * is left out; an error payload or another schema gives null.
 */
export function parseAgentSwapList(stdout: string, readAt: number): AgentSwapUsage | null {
    let body: unknown
    try {
        body = JSON.parse(stdout)
    } catch {
        return null
    }
    if (!isRecord(body) || body.schemaVersion !== 1 || 'error' in body || !Array.isArray(body.accounts)) return null
    const accounts: PhoneUsageAccount[] = []
    for (const row of body.accounts) {
        if (!isRecord(row) || typeof row.email !== 'string') continue
        // the human view falls back to the last good reading when the current one is too old to trust
        const usage = isRecord(row.usage) ? row.usage : isRecord(row.lastGoodUsage) ? row.lastGoodUsage : null
        const fiveHour = windowOf(usage?.fiveHour, 'pct')
        const weekly = windowOf(usage?.sevenDay, 'pct')
        const seven = usage && isRecord(usage.sevenDay) ? usage.sevenDay : null
        const age = typeof row.usageAgeSeconds === 'number' ? row.usageAgeSeconds : typeof row.lastGoodAgeSeconds === 'number' ? row.lastGoodAgeSeconds : undefined
        accounts.push({
            label: typeof row.alias === 'string' && row.alias.trim() ? row.alias.trim() : shortenEmail(row.email),
            active: row.active === true,
            status: typeof row.usageStatus === 'string' ? row.usageStatus : 'unknown',
            ...(fiveHour ? { fiveHour } : {}),
            ...(weekly
                ? {
                      sevenDay: {
                          ...weekly,
                          ...(seven && isoOrNull(seven.projectedExhaustionAt) ? { projectedExhaustionAt: isoOrNull(seven.projectedExhaustionAt)! } : {}),
                          ...(seven && typeof seven.willLastToReset === 'boolean' ? { willLastToReset: seven.willLastToReset } : {})
                      }
                  }
                : {}),
            ...(age !== undefined ? { ageSeconds: Math.round(age) } : {})
        })
    }
    const others = isRecord(body.otherAgents) ? body.otherAgents : null
    const codexRow = others && isRecord(others.codex) && others.codex.status === 'ok' ? others.codex : null
    const primary = windowOf(codexRow?.primary, 'usedPercent')
    const secondary = windowOf(codexRow?.secondary, 'usedPercent')
    return {
        accounts,
        ...(primary || secondary ? { codex: { ...(primary ? { primary } : {}), ...(secondary ? { secondary } : {}) } } : {}),
        readAt
    }
}

/**
 * `aswap list --json` at most once a minute, one run at a time. A failure is kept as long as an
 * answer is, so a Mac without agent-swap does not start a login shell on every look.
 */
export class AgentSwapReader {
    private cached: { at: number; value: AgentSwapUsage | null } | null = null
    private running: Promise<AgentSwapUsage | null> | null = null

    constructor(
        private readonly run: AgentSwapRun,
        private readonly now: () => number = Date.now,
        private readonly cacheMs = AGENT_SWAP_CACHE_MS
    ) {}

    read(): Promise<AgentSwapUsage | null> {
        const now = this.now()
        if (this.cached && now - this.cached.at < this.cacheMs) return Promise.resolve(this.cached.value)
        if (this.running) return this.running
        this.running = this.run()
            .then((stdout) => parseAgentSwapList(stdout, this.now()))
            .catch(() => null)
            .then((value) => {
                this.cached = { at: this.now(), value }
                this.running = null
                return value
            })
        return this.running
    }
}

/**
 * The login shell finds `aswap` where the user's PATH puts it (an app opened from Finder does not
 * inherit the terminal's PATH). No path is written here: it is whatever the user installed.
 */
export function runAgentSwapInLoginShell(shell = process.env.SHELL || '/bin/zsh', timeoutMs = AGENT_SWAP_TIMEOUT_MS): AgentSwapRun {
    return () =>
        new Promise((resolve, reject) => {
            const child = execFile(shell, ['-l', '-c', 'command -v aswap >/dev/null 2>&1 || exit 127; exec aswap list --json'], { timeout: timeoutMs, maxBuffer: AGENT_SWAP_MAX_BYTES, killSignal: 'SIGKILL' }, (error, stdout) => {
                if (error) reject(error)
                else resolve(stdout)
            })
            // nothing to type: a command that reads stdin ends now instead of waiting out the timeout
            child.stdin?.end()
        })
}

function fromAppWindow(window: UsageWindow | undefined): PhoneUsageWindow | undefined {
    if (!window) return undefined
    return { usedPercent: window.usedPercent, resetsAt: window.resetsAt ? new Date(window.resetsAt * 1000).toISOString() : null }
}

/** The app's own reading, in the phone's shape. */
export function appUsageForPhone(snapshot: UsageSnapshot): PhoneUsageResponse['app'] {
    const app: PhoneUsageResponse['app'] = {}
    if (snapshot.claude) {
        const fiveHour = fromAppWindow(snapshot.claude.fiveHour)
        const sevenDay = fromAppWindow(snapshot.claude.sevenDay)
        app.claude = { ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}), updatedAt: snapshot.claude.updatedAt }
    }
    if (snapshot.codex) {
        const weekly = fromAppWindow(snapshot.codex.weekly)
        app.codex = { ...(weekly ? { weekly } : {}), updatedAt: snapshot.codex.updatedAt }
    }
    return app
}
