import { EventEmitter } from 'events'
import { existsSync, readdirSync, statSync, openSync, readSync, closeSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { UsageSnapshot, UsageWindow, UsageAlertSettings, AgentToolName, DEFAULT_USAGE_ALERTS } from '../shared/types'
import { ClaudeStatusLinePayload } from './AgentHookBridge'

/**
 * Tracks how much of each provider's rate limit has been consumed.
 *
 * Both numbers here are reported by the provider, not estimated from token
 * counts, so they match what `/usage` and `/status` show inside the CLIs:
 *   - Claude Code exposes `rate_limits` only through the statusLine payload,
 *     which arrives via AgentHookBridge.
 *   - Codex records `rate_limits` into its session rollout files, which we read
 *     directly — no hook required.
 */

/** Codex is tracked on its weekly window, which is 7 days expressed in minutes. */
const CODEX_WEEKLY_WINDOW_MINUTES = 10080

/** How often to re-read Codex rollout files. */
const CODEX_POLL_INTERVAL_MS = 60_000

/** Only the tail of a rollout file is scanned; limits are appended over time. */
const ROLLOUT_TAIL_BYTES = 512 * 1024

/** Rollout files older than this are assumed to predate the current windows. */
const ROLLOUT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

interface CodexRateLimitWindow {
    used_percent?: number
    window_minutes?: number
    resets_at?: number
}

interface CodexRateLimits {
    primary?: CodexRateLimitWindow | null
    secondary?: CodexRateLimitWindow | null
    plan_type?: string
}

export interface UsageThresholdAlert {
    tool: AgentToolName
    label: string
    usedPercent: number
    threshold: number
    resetsAt: number | null
}

export declare interface UsageTracker {
    on(event: 'update', listener: (snapshot: UsageSnapshot) => void): this
    on(event: 'threshold', listener: (alert: UsageThresholdAlert) => void): this
}

export class UsageTracker extends EventEmitter {
    private snapshot: UsageSnapshot = {}
    private alertSettings: UsageAlertSettings = DEFAULT_USAGE_ALERTS
    private pollTimer: NodeJS.Timeout | null = null

    /**
     * Windows we have already warned about, keyed by tool+window+reset time.
     * Including the reset time means a new window automatically re-arms the
     * alert without any explicit bookkeeping.
     */
    private firedAlerts = new Set<string>()

    private readonly codexSessionsDir = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'sessions')

    start(): void {
        this.readCodexUsage()
        this.pollTimer = setInterval(() => this.readCodexUsage(), CODEX_POLL_INTERVAL_MS)
    }

    stop(): void {
        if (this.pollTimer) {
            clearInterval(this.pollTimer)
            this.pollTimer = null
        }
    }

    getSnapshot(): UsageSnapshot {
        return this.snapshot
    }

    setAlertSettings(settings: UsageAlertSettings): void {
        this.alertSettings = settings
    }

    // ------------------------------------------------------------------
    // Claude Code
    // ------------------------------------------------------------------

    /**
     * Ingests a statusLine payload.
     *
     * `rate_limits` is absent for API-key users and for subscription users until
     * the session's first API response, so every field is treated as optional.
     */
    ingestClaudeStatusLine(payload: ClaudeStatusLinePayload): void {
        const limits = payload.rate_limits
        const contextPercent = payload.context_window?.used_percentage

        if (!limits && contextPercent == null) return

        const fiveHour = toWindow(limits?.five_hour?.used_percentage, limits?.five_hour?.resets_at, 300, '5h')
        const sevenDay = toWindow(limits?.seven_day?.used_percentage, limits?.seven_day?.resets_at, 10080, '7d')

        this.snapshot = {
            ...this.snapshot,
            claude: {
                fiveHour: fiveHour ?? this.snapshot.claude?.fiveHour,
                sevenDay: sevenDay ?? this.snapshot.claude?.sevenDay,
                contextPercent: contextPercent ?? undefined,
                updatedAt: Date.now()
            }
        }

        this.emit('update', this.snapshot)
        this.checkThresholds()
    }

    // ------------------------------------------------------------------
    // Codex
    // ------------------------------------------------------------------

    /**
     * Reads the most recent Codex rollout file and extracts the last recorded
     * rate limit block.
     */
    private readCodexUsage(): void {
        try {
            const file = this.findLatestRollout()
            if (!file) return

            const limits = readLastRateLimits(file)
            if (!limits) return

            const weekly = pickWeeklyWindow(limits)
            if (!weekly) return

            this.snapshot = {
                ...this.snapshot,
                codex: {
                    weekly,
                    planType: limits.plan_type,
                    updatedAt: Date.now()
                }
            }

            this.emit('update', this.snapshot)
            this.checkThresholds()
        } catch (error) {
            console.error('[UsageTracker] Codex usage read failed:', error)
        }
    }

    /**
     * Returns the most recently *modified* rollout file within the age cutoff.
     *
     * Modification time rather than file name decides the winner: resuming an
     * older session appends to its original rollout, so the newest limits are
     * regularly found in a file whose name is several days old. Verified on a
     * real session tree where the newest-by-name file held stale numbers.
     */
    private findLatestRollout(): string | null {
        if (!existsSync(this.codexSessionsDir)) return null

        const cutoff = Date.now() - ROLLOUT_MAX_AGE_MS
        let newestPath: string | null = null
        let newestMtime = 0

        const descend = (dir: string, depth: number): void => {
            let entries: string[]
            try {
                entries = readdirSync(dir)
            } catch {
                return
            }

            for (const name of entries) {
                const path = join(dir, name)
                let info: ReturnType<typeof statSync>
                try {
                    info = statSync(path)
                } catch {
                    continue
                }

                if (info.isDirectory()) {
                    if (depth < 3) descend(path, depth + 1)
                } else if (name.startsWith('rollout-') && name.endsWith('.jsonl')) {
                    if (info.mtimeMs < cutoff) continue
                    if (info.mtimeMs > newestMtime) {
                        newestPath = path
                        newestMtime = info.mtimeMs
                    }
                }
            }
        }

        descend(this.codexSessionsDir, 0)
        return newestPath
    }

    // ------------------------------------------------------------------
    // Threshold alerts
    // ------------------------------------------------------------------

    private checkThresholds(): void {
        if (!this.alertSettings.enabled) return

        const candidates: Array<{ tool: AgentToolName; window?: UsageWindow; threshold: number }> = [
            { tool: 'claude', window: this.snapshot.claude?.fiveHour, threshold: this.alertSettings.claudeThresholdPercent },
            { tool: 'claude', window: this.snapshot.claude?.sevenDay, threshold: this.alertSettings.claudeThresholdPercent },
            { tool: 'codex', window: this.snapshot.codex?.weekly, threshold: this.alertSettings.codexThresholdPercent }
        ]

        for (const { tool, window, threshold } of candidates) {
            // A threshold of 0 disables that tool without touching the others.
            if (!window || threshold <= 0) continue
            if (window.usedPercent < threshold) continue

            const key = `${tool}:${window.label}:${window.resetsAt ?? 'unknown'}`
            if (this.firedAlerts.has(key)) continue

            this.firedAlerts.add(key)
            this.emit('threshold', {
                tool,
                label: window.label,
                usedPercent: window.usedPercent,
                threshold,
                resetsAt: window.resetsAt
            })
        }

        // Keep the fired-alert set from growing without bound across long runs.
        if (this.firedAlerts.size > 64) {
            this.firedAlerts = new Set(Array.from(this.firedAlerts).slice(-32))
        }
    }
}

// ----------------------------------------------------------------------
// Pure helpers (exported for tests)
// ----------------------------------------------------------------------

function toWindow(
    usedPercent: number | undefined,
    resetsAt: number | undefined,
    windowMinutes: number,
    label: string
): UsageWindow | undefined {
    if (typeof usedPercent !== 'number' || Number.isNaN(usedPercent)) return undefined
    return {
        usedPercent: Math.max(0, Math.min(100, usedPercent)),
        resetsAt: typeof resetsAt === 'number' ? resetsAt : null,
        windowMinutes,
        label
    }
}

/**
 * Chooses the weekly window out of a Codex rate limit block.
 *
 * The `primary`/`secondary` slots are not stable across plans — on some
 * accounts `primary` is the weekly window and `secondary` is null — so the
 * window is identified by its duration rather than by its position.
 */
export function pickWeeklyWindow(limits: CodexRateLimits): UsageWindow | undefined {
    const windows = [limits.primary, limits.secondary].filter(
        (w): w is CodexRateLimitWindow => !!w && typeof w.used_percent === 'number'
    )
    if (windows.length === 0) return undefined

    const weekly =
        windows.find((w) => w.window_minutes === CODEX_WEEKLY_WINDOW_MINUTES) ??
        windows.reduce((longest, current) =>
            (current.window_minutes ?? 0) > (longest.window_minutes ?? 0) ? current : longest
        )

    return toWindow(weekly.used_percent, weekly.resets_at, weekly.window_minutes ?? CODEX_WEEKLY_WINDOW_MINUTES, '7d')
}

/**
 * Extracts the last `rate_limits` object from a rollout file.
 *
 * Only the tail is read: rollout files grow to tens of megabytes over a long
 * session and the newest limits are always at the end.
 */
export function readLastRateLimits(filePath: string): CodexRateLimits | null {
    let fd: number | null = null
    try {
        const size = statSync(filePath).size
        const length = Math.min(size, ROLLOUT_TAIL_BYTES)
        const position = size - length

        fd = openSync(filePath, 'r')
        const buffer = Buffer.alloc(length)
        readSync(fd, buffer, 0, length, position)
        const tail = buffer.toString('utf-8')

        const marker = '"rate_limits":'
        const index = tail.lastIndexOf(marker)
        if (index === -1) return null

        const json = extractJsonObject(tail, index + marker.length)
        if (!json) return null

        return JSON.parse(json) as CodexRateLimits
    } catch {
        return null
    } finally {
        if (fd !== null) {
            try {
                closeSync(fd)
            } catch {
                // Nothing actionable if the descriptor is already gone.
            }
        }
    }
}

/**
 * Reads one balanced `{...}` starting at or after `start`, respecting string
 * literals so a brace inside a message body cannot end the object early.
 */
function extractJsonObject(text: string, start: number): string | null {
    let i = start
    while (i < text.length && text[i] !== '{') i++
    if (i >= text.length) return null

    let depth = 0
    let inString = false
    let escaped = false

    for (let j = i; j < text.length; j++) {
        const ch = text[j]

        if (inString) {
            if (escaped) escaped = false
            else if (ch === '\\') escaped = true
            else if (ch === '"') inString = false
            continue
        }

        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
            depth--
            if (depth === 0) return text.slice(i, j + 1)
        }
    }

    // Truncated by the tail window; the next poll will see a complete record.
    return null
}
