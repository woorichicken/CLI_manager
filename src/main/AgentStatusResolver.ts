import { EventEmitter } from 'events'
import { AgentEvent, AgentEventKind, AgentStatusSource, AgentStatusUpdate, SessionStatus } from '../shared/types'

/**
 * Turns normalized agent events into per-terminal status.
 *
 * Precedence (highest first):
 *   1. hook      — the CLI told us exactly what happened
 *   2. osc       — terminal title sequence
 *   3. heuristic — screen-hash guessing, the legacy path
 *
 * A lower-precedence source can never overwrite a higher one while the higher
 * one is still fresh. This is what makes the migration safe: the old heuristic
 * keeps running untouched and simply loses every argument with a hook event, so
 * sessions without hooks behave exactly as they do today.
 */

/**
 * How long a hook event suppresses the heuristic for the same terminal.
 *
 * Sized against the longest realistic gap between lifecycle events: an agent
 * can legitimately run for many minutes between `turn-start` and `turn-end`.
 * If hooks are uninstalled mid-session the terminal silently falls back to the
 * heuristic once this expires.
 */
const HOOK_AUTHORITY_MS = 30 * 60 * 1000

/** OSC titles are refreshed constantly, so their authority window is short. */
const OSC_AUTHORITY_MS = 30 * 1000

const SOURCE_RANK: Record<AgentStatusSource, number> = {
    hook: 3,
    osc: 2,
    heuristic: 1
}

/** Lifecycle event -> the status a terminal is in once it has been observed. */
const EVENT_STATUS: Record<AgentEventKind, SessionStatus> = {
    'session-start': 'ready',
    'turn-start': 'running',
    'turn-end': 'ready',
    'permission': 'ready',
    'notification': 'ready',
    'session-end': 'idle'
}

/** Events that mean a human has to do something before work continues. */
const AWAITING_INPUT_EVENTS: AgentEventKind[] = ['permission', 'notification']

interface ResolvedStatus {
    status: SessionStatus
    source: AgentStatusSource
    detail?: string
    awaitingInput: boolean
    at: number
}

/** Minimal shape the resolver needs in order to find a terminal. */
export interface TerminalLookupEntry {
    terminalId: string
    cwd: string
    cliSessionId?: string
    cliToolName?: string
}

export declare interface AgentStatusResolver {
    on(event: 'status', listener: (update: AgentStatusUpdate) => void): this
}

export class AgentStatusResolver extends EventEmitter {
    private readonly statuses = new Map<string, ResolvedStatus>()

    /**
     * @param lookup Supplies the current terminal list. Injected as a callback
     *               rather than a snapshot because sessions are created and
     *               destroyed while the resolver is alive.
     */
    constructor(private readonly lookup: () => TerminalLookupEntry[]) {
        super()
    }

    /**
     * Maps an event onto a terminal.
     *
     * Claude Code is matched on session id, which CLI Manager already controls
     * because it injects `--session-id` when the command is typed — an exact
     * key, even with several agents in one directory.
     *
     * Codex reports a `thread-id` we never see, so it falls back to the working
     * directory. When that is ambiguous, a session whose tool name is Codex
     * wins over one that is not; still ambiguous means we decline to guess.
     */
    private findTerminal(event: AgentEvent): string | null {
        const entries = this.lookup()

        if (event.cliSessionId) {
            const exact = entries.find((e) => e.cliSessionId === event.cliSessionId)
            if (exact) return exact.terminalId
        }

        if (!event.cwd) return null

        const inCwd = entries.filter((e) => e.cwd === event.cwd)
        if (inCwd.length === 0) return null
        if (inCwd.length === 1) return inCwd[0].terminalId

        const byTool = inCwd.filter((e) => e.cliToolName === event.tool)
        if (byTool.length === 1) return byTool[0].terminalId

        // Several candidate terminals and nothing to separate them. Reporting
        // the wrong session's status is worse than reporting none.
        return null
    }

    /** Records a lifecycle event from an official CLI hook. */
    applyEvent(event: AgentEvent): void {
        const terminalId = this.findTerminal(event)
        if (!terminalId) return

        const status = EVENT_STATUS[event.kind]
        if (!status) return

        this.commit(terminalId, {
            status,
            source: 'hook',
            detail: event.detail,
            awaitingInput: AWAITING_INPUT_EVENTS.includes(event.kind),
            at: event.at
        })
    }

    /**
     * Records a status derived from the terminal title or the screen heuristic.
     * Dropped when a higher-precedence source has spoken recently.
     */
    applyObservedStatus(terminalId: string, status: SessionStatus, source: AgentStatusSource): void {
        this.commit(terminalId, { status, source, awaitingInput: false, at: Date.now() })
    }

    private commit(terminalId: string, next: ResolvedStatus): void {
        const current = this.statuses.get(terminalId)

        if (current && !this.canOverride(current, next)) return

        // Suppress no-op churn so the renderer is not re-rendered needlessly.
        if (
            current &&
            current.status === next.status &&
            current.awaitingInput === next.awaitingInput &&
            current.source === next.source
        ) {
            this.statuses.set(terminalId, next)
            return
        }

        this.statuses.set(terminalId, next)
        this.emit('status', {
            terminalId,
            status: next.status,
            source: next.source,
            detail: next.detail,
            awaitingInput: next.awaitingInput,
            at: next.at
        })
    }

    private canOverride(current: ResolvedStatus, next: ResolvedStatus): boolean {
        const currentRank = SOURCE_RANK[current.source]
        const nextRank = SOURCE_RANK[next.source]

        if (nextRank >= currentRank) return true

        // A weaker source may still take over once the stronger one goes quiet,
        // which is how a session recovers if hooks are removed mid-flight.
        const authority = current.source === 'hook' ? HOOK_AUTHORITY_MS : OSC_AUTHORITY_MS
        return Date.now() - current.at > authority
    }

    getStatus(terminalId: string): AgentStatusUpdate | null {
        const entry = this.statuses.get(terminalId)
        if (!entry) return null
        return { terminalId, ...entry }
    }

    /** All known statuses, for hydrating a window that just opened. */
    snapshot(): AgentStatusUpdate[] {
        return Array.from(this.statuses.entries()).map(([terminalId, entry]) => ({ terminalId, ...entry }))
    }

    forget(terminalId: string): void {
        this.statuses.delete(terminalId)
    }
}
