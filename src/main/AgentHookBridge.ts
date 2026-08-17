import { EventEmitter } from 'events'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, watch, FSWatcher } from 'fs'
import { join } from 'path'
import { AgentEvent, AgentEventKind, AgentToolName } from '../shared/types'

/**
 * Reads the hook spool directory and turns raw CLI payloads into normalized
 * `AgentEvent`s.
 *
 * Delivery model: hook scripts drop one file per event and exit. We watch the
 * directory, drain it, and delete what we consumed. `fs.watch` is the fast path;
 * a slow sweep runs alongside it because directory watching is not guaranteed to
 * deliver every event on every platform (and delivers nothing for files written
 * while the app was closed).
 */

/** Envelope written by every bridge script. */
interface SpoolEnvelope {
    climanager?: { source?: string }
    payload?: unknown
}

/** Claude Code hook payload fields we rely on. */
interface ClaudeHookPayload {
    hook_event_name?: string
    session_id?: string
    cwd?: string
    tool_name?: string
    message?: string
}

/** Codex `agent-turn-complete` payload. Note the hyphenated keys. */
interface CodexNotifyPayload {
    type?: string
    'thread-id'?: string
    'turn-id'?: string
    cwd?: string
    'last-assistant-message'?: string
}

/** Claude statusLine payload — the only source of official rate limits. */
export interface ClaudeStatusLinePayload {
    session_id?: string
    workspace?: { current_dir?: string; project_dir?: string }
    context_window?: { used_percentage?: number | null }
    rate_limits?: {
        five_hour?: { used_percentage?: number; resets_at?: number }
        seven_day?: { used_percentage?: number; resets_at?: number }
    }
}

const CLAUDE_EVENT_MAP: Record<string, AgentEventKind> = {
    SessionStart: 'session-start',
    UserPromptSubmit: 'turn-start',
    Stop: 'turn-end',
    PermissionRequest: 'permission',
    Notification: 'notification',
    SessionEnd: 'session-end'
}

/** Sweep interval for files fs.watch did not report. */
const SWEEP_INTERVAL_MS = 1000

/** Guards against a runaway producer flooding the app on a single drain. */
const MAX_FILES_PER_DRAIN = 200

export declare interface AgentHookBridge {
    on(event: 'agent-event', listener: (payload: AgentEvent) => void): this
    on(event: 'claude-statusline', listener: (payload: ClaudeStatusLinePayload) => void): this
}

export class AgentHookBridge extends EventEmitter {
    private watcher: FSWatcher | null = null
    private sweepTimer: NodeJS.Timeout | null = null
    private draining = false

    constructor(private readonly spoolDir: string) {
        super()
    }

    start(): void {
        try {
            mkdirSync(this.spoolDir, { recursive: true })
        } catch (error) {
            console.error('[AgentHookBridge] Cannot create spool directory:', error)
            return
        }

        try {
            this.watcher = watch(this.spoolDir, () => {
                void this.drain()
            })
        } catch (error) {
            // Not fatal: the periodic sweep below still delivers events, just
            // with up to one second of latency.
            console.error('[AgentHookBridge] Directory watch unavailable, falling back to polling:', error)
        }

        this.sweepTimer = setInterval(() => {
            void this.drain()
        }, SWEEP_INTERVAL_MS)

        void this.drain()
    }

    stop(): void {
        this.watcher?.close()
        this.watcher = null
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer)
            this.sweepTimer = null
        }
    }

    /**
     * Consumes everything currently in the spool.
     *
     * Re-entrancy matters here: `fs.watch` fires once per file, so a burst of
     * events would otherwise start several overlapping drains that race to
     * unlink the same paths.
     */
    private async drain(): Promise<void> {
        if (this.draining) return
        this.draining = true

        try {
            if (!existsSync(this.spoolDir)) return

            // Order matters: 'turn-start' followed by 'turn-end' means idle,
            // the reverse means running. mktemp names are random, so the spool
            // is sorted by write time before anything is dispatched.
            const names = readdirSync(this.spoolDir)
                .filter((n) => n.startsWith('ev-'))
                .map((name) => {
                    const path = join(this.spoolDir, name)
                    try {
                        return { name, path, at: statSync(path).mtimeMs }
                    } catch {
                        return { name, path, at: 0 }
                    }
                })
                .sort((a, b) => a.at - b.at)
                .slice(0, MAX_FILES_PER_DRAIN)

            for (const { path } of names) {
                let raw: string
                try {
                    raw = readFileSync(path, 'utf-8')
                } catch {
                    // The hook may still be writing; leave it for the next sweep.
                    continue
                }

                // A partially written file is not an error — skip it now and
                // pick it up once the writer has closed it.
                let envelope: SpoolEnvelope
                try {
                    envelope = JSON.parse(raw) as SpoolEnvelope
                } catch {
                    if (raw.length > 0 && this.isStale(path)) this.remove(path)
                    continue
                }

                this.remove(path)
                try {
                    this.dispatch(envelope)
                } catch (error) {
                    console.error('[AgentHookBridge] Failed to dispatch event:', error)
                }
            }
        } catch (error) {
            console.error('[AgentHookBridge] Drain failed:', error)
        } finally {
            this.draining = false
        }
    }

    /** A file that never became valid JSON is dropped rather than retried forever. */
    private isStale(path: string): boolean {
        try {
            return Date.now() - statSync(path).mtimeMs > 5000
        } catch {
            return true
        }
    }

    private remove(path: string): void {
        try {
            unlinkSync(path)
        } catch {
            // Already gone; nothing to do.
        }
    }

    private dispatch(envelope: SpoolEnvelope): void {
        const source = envelope.climanager?.source
        const payload = envelope.payload

        if (!source || payload === null || typeof payload !== 'object') return

        switch (source) {
            case 'claude-hook':
                this.dispatchClaudeHook(payload as ClaudeHookPayload)
                break
            case 'claude-statusline':
                this.emit('claude-statusline', payload as ClaudeStatusLinePayload)
                break
            case 'codex-notify':
                this.dispatchCodexNotify(payload as CodexNotifyPayload)
                break
        }
    }

    private dispatchClaudeHook(payload: ClaudeHookPayload): void {
        const kind = payload.hook_event_name ? CLAUDE_EVENT_MAP[payload.hook_event_name] : undefined
        if (!kind) return

        this.emitEvent({
            tool: 'claude',
            kind,
            cliSessionId: payload.session_id,
            cwd: payload.cwd,
            at: Date.now(),
            detail: kind === 'permission' ? payload.tool_name : payload.message
        })
    }

    private dispatchCodexNotify(payload: CodexNotifyPayload): void {
        // Codex only emits agent-turn-complete today; anything else is ignored
        // rather than guessed at.
        if (payload.type && payload.type !== 'agent-turn-complete') return

        this.emitEvent({
            tool: 'codex',
            kind: 'turn-end',
            cliSessionId: payload['thread-id'],
            cwd: payload.cwd,
            at: Date.now(),
            detail: payload['last-assistant-message']?.slice(0, 200)
        })
    }

    private emitEvent(event: AgentEvent): void {
        this.emit('agent-event', event)
    }
}

/** Exposed for tests: maps a raw CLI event name onto our vocabulary. */
export function normalizeClaudeEventName(name: string): AgentEventKind | undefined {
    return CLAUDE_EVENT_MAP[name]
}

/** Exposed for tests: which tools the bridge understands. */
export const SUPPORTED_AGENT_TOOLS: AgentToolName[] = ['claude', 'codex']
