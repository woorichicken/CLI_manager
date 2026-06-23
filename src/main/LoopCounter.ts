/**
 * LoopCounter.ts
 *
 * Pure detection logic for counting Claude Code /loop iterations.
 * No Electron or node-pty imports — fully unit-testable.
 *
 * Iteration detection strategy:
 *   - 'settle' mode (default): count a loop when terminal transitions running → ready
 *     (an iteration has completed and the model is now waiting).
 *   - 'start'  mode: count a loop when terminal transitions ready → running
 *     (a new iteration has begun).
 *   - customPattern: if a non-empty regex string is provided, count matching output
 *     lines instead of status transitions (pattern takes precedence over mode).
 *
 * Debounce rationale:
 *   Claude Code sometimes emits rapid ready→running→ready flickers during tool
 *   compaction or mid-iteration tool waits. Without debouncing, each flicker looks
 *   like a new iteration. By requiring at least `debounceMs` between successive
 *   counts, we collapse these sub-loops into a single logical iteration.
 */

import type { LoopDetectionConfig, LoopStatus } from '../shared/types'

// ---------------------------------------------------------------------------
// Public callback type (G-3 wires this)
// ---------------------------------------------------------------------------

export interface LoopIterationCallback {
    (ev: { terminalId: string; index: number; at: number }): void
}

// ---------------------------------------------------------------------------
// Internal per-terminal state
// ---------------------------------------------------------------------------

interface TerminalState {
    previousStatus: LoopStatus
    count: number
    /** Timestamp of the most recent counted iteration, or null if never counted. */
    lastCountedAt: number | null
    /** Buffer for partial output lines (customPattern mode). */
    lineBuffer: string
    /**
     * Whether the first status-based settle has been consumed.
     * The first running→ready (or ready→running) after a session starts (or
     * after a restart) is claude's startup, not a real loop iteration, so it is
     * skipped. Only applies to status modes — customPattern matches always count.
     */
    primed: boolean
}

// ---------------------------------------------------------------------------
// LoopCounter
// ---------------------------------------------------------------------------

/**
 * Tracks loop iteration counts for one or more terminal sessions.
 *
 * Call `registerSession` to begin tracking a terminal, then feed status
 * transitions via `recordStatus` and raw PTY output via `recordOutput`.
 * The optional `onIteration` callback fires each time a new iteration is
 * confirmed (after debounce).
 */
export class LoopCounter {
    private config: LoopDetectionConfig
    private readonly onIteration?: LoopIterationCallback

    /** Per-terminal tracking state. */
    private readonly states = new Map<string, TerminalState>()

    /** Compiled regex from config.customPattern, or null. null means use status mode. */
    private patternRegex: RegExp | null = null

    constructor(config: LoopDetectionConfig, onIteration?: LoopIterationCallback) {
        this.config = config
        this.onIteration = onIteration
        this.compilePattern(config.customPattern)
    }

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    /** Replace the current detection config at runtime. */
    updateConfig(config: LoopDetectionConfig): void {
        this.config = config
        this.compilePattern(config.customPattern)
    }

    // -----------------------------------------------------------------------
    // Session lifecycle
    // -----------------------------------------------------------------------

    /**
     * Begin tracking a terminal session.
     * Safe to call multiple times — subsequent calls are no-ops (idempotent).
     */
    registerSession(terminalId: string): void {
        if (!this.states.has(terminalId)) {
            this.states.set(terminalId, {
                previousStatus: 'ready',
                count: 0,
                lastCountedAt: null,
                lineBuffer: '',
                primed: false,
            })
        }
    }

    /**
     * Stop tracking a terminal and drop all associated state.
     */
    unregister(terminalId: string): void {
        this.states.delete(terminalId)
    }

    // -----------------------------------------------------------------------
    // Status-based counting
    // -----------------------------------------------------------------------

    /**
     * Feed a status transition from the terminal status detector.
     *
     * When `config.customPattern` is set and compiles successfully, this method
     * only updates `previousStatus` (pattern mode takes precedence).
     *
     * @param terminalId - the terminal being updated
     * @param status     - new LoopStatus value
     * @param now        - current timestamp (ms since epoch)
     */
    recordStatus(terminalId: string, status: LoopStatus, now: number): void {
        const state = this.ensureState(terminalId)
        const prev = state.previousStatus

        // Always persist the new status regardless of counting.
        state.previousStatus = status

        // When pattern mode is active, status transitions do not count.
        if (this.patternRegex !== null) {
            return
        }

        // 'stopped' never triggers a count.
        if (status === 'stopped') {
            return
        }

        let shouldCount = false
        if (this.config.countMode === 'settle' && prev === 'running' && status === 'ready') {
            shouldCount = true
        } else if (this.config.countMode === 'start' && prev === 'ready' && status === 'running') {
            shouldCount = true
        }

        if (shouldCount) {
            // Skip the very first settle after a session starts (or restarts):
            // that transition is claude's startup, not a real loop iteration.
            if (!state.primed) {
                state.primed = true
                return
            }
            this.maybeCount(terminalId, state, now)
        }
    }

    // -----------------------------------------------------------------------
    // Pattern-based counting
    // -----------------------------------------------------------------------

    /**
     * Feed raw PTY output to check against `config.customPattern`.
     *
     * Lines are buffered across calls; only complete lines (ending in '\n') are
     * matched. If no customPattern is configured (or it is invalid), this is a
     * no-op.
     *
     * @param terminalId - the terminal that produced the output
     * @param data       - raw output chunk (may contain multiple lines or partial lines)
     * @param now        - current timestamp (ms since epoch)
     */
    recordOutput(terminalId: string, data: string, now: number): void {
        if (this.patternRegex === null) {
            return
        }

        const state = this.ensureState(terminalId)
        state.lineBuffer += data

        // Process all complete lines.
        const newlineIdx = state.lineBuffer.lastIndexOf('\n')
        if (newlineIdx === -1) {
            // No complete line yet — keep buffering.
            return
        }

        const completeChunk = state.lineBuffer.slice(0, newlineIdx + 1)
        state.lineBuffer = state.lineBuffer.slice(newlineIdx + 1)

        const lines = completeChunk.split('\n')
        for (const line of lines) {
            if (line.length > 0 && this.patternRegex.test(line)) {
                this.maybeCount(terminalId, state, now)
            }
        }
    }

    // -----------------------------------------------------------------------
    // Getters & reset
    // -----------------------------------------------------------------------

    /** Return the current iteration count for a terminal (0 if unknown). */
    getCount(terminalId: string): number {
        return this.states.get(terminalId)?.count ?? 0
    }

    /** Return the timestamp of the most recent counted iteration, or null. */
    getLastAt(terminalId: string): number | null {
        return this.states.get(terminalId)?.lastCountedAt ?? null
    }

    /**
     * Reset the iteration counter for a terminal (e.g. on manual restart).
     * Re-arms skip-first and rebaselines `previousStatus` to 'ready' (as on a
     * fresh session); preserves `lineBuffer` so partial-line detection survives.
     */
    reset(terminalId: string): void {
        const state = this.states.get(terminalId)
        if (state) {
            state.count = 0
            state.lastCountedAt = null
            // Re-arm skip-first so the post-restart claude startup isn't counted,
            // and reset previousStatus to the same baseline as a fresh session so
            // the post-restart startup is classified identically in every count
            // mode (otherwise 'start' mode would skip the first real iteration).
            state.primed = false
            state.previousStatus = 'ready'
        }
    }

    // -----------------------------------------------------------------------
    // Private helpers
    // -----------------------------------------------------------------------

    /**
     * Auto-register an unknown terminal and return its state.
     * This keeps recordStatus / recordOutput / getCount safe for unknown IDs.
     */
    private ensureState(terminalId: string): TerminalState {
        if (!this.states.has(terminalId)) {
            this.registerSession(terminalId)
        }
        return this.states.get(terminalId)!
    }

    /**
     * Apply the debounce guard and — if it passes — increment the count and
     * fire the onIteration callback.
     *
     * Debounce rule: if a previous count exists and the gap since then is
     * shorter than `config.debounceMs`, treat this event as part of the SAME
     * logical iteration (do NOT increment, do NOT fire callback).
     *
     * Why debounce on counting rather than on the status transition?
     * Status transitions are emitted by the output monitor and can fire
     * multiple times in rapid succession (e.g. running→ready→running during
     * tool invocations). We want all those rapid transitions to collapse into
     * exactly one "loop completed" event.
     */
    private maybeCount(terminalId: string, state: TerminalState, now: number): void {
        const withinDebounce =
            state.lastCountedAt !== null &&
            now - state.lastCountedAt < this.config.debounceMs

        if (withinDebounce) {
            // Same logical iteration — swallow this transition silently.
            return
        }

        state.count++
        state.lastCountedAt = now

        this.onIteration?.({ terminalId, index: state.count, at: now })
    }

    /**
     * Compile `config.customPattern` into a RegExp.
     * On invalid pattern (or empty/undefined), falls back to status-based
     * counting by setting `this.patternRegex = null`.
     */
    private compilePattern(pattern: string | undefined): void {
        if (!pattern || pattern.trim().length === 0) {
            this.patternRegex = null
            return
        }

        try {
            this.patternRegex = new RegExp(pattern)
        } catch {
            // Invalid regex — fall back to status-based counting.
            this.patternRegex = null
        }
    }
}
