import type { AgentStatusUpdate, SessionScreenState, SessionScreenStatus, SessionScreenStatusMessage } from '../shared/types'

/**
 * Sidebar status dots without hooks (Settings > General "Show Session Status").
 *
 * Every second, read each session's screen mirror (decision 0008 keeps one for
 * every terminal) and send the renderer only the sessions whose dot changed.
 * The same screen rules as the Related dialog's "Working" / "Waiting for you"
 * and the Control API's awaitingInput, so the three never disagree on a question.
 *
 * Off means off: no timer, no reads, no IPC. A screen is re-read only when the
 * session printed something since the last read, so idle sessions cost a map
 * lookup per tick.
 */

/** A dot a second late is fine; the Related dialog peeks every 2s. */
export const SESSION_SCREEN_STATUS_INTERVAL_MS = 1000

/**
 * xterm parses output asynchronously. A read within this long of the last
 * output may have seen the screen before the tail landed, so it is read again
 * on the next tick before being trusted.
 */
const PARSE_SETTLE_MS = 500

interface ScreenReader {
    ids(): string[]
    hasExited(id: string): boolean
    lastOutputAt(id: string): number
    screenStatus(id: string): { busy: boolean; question: string | null }
}

interface Deps {
    mirror: ScreenReader
    hookStatus: (sessionId: string) => AgentStatusUpdate | null
    publish: (message: SessionScreenStatusMessage) => void
    /** Test instrumentation: how long one tick took and how many sessions it covered. */
    onTick?: (ms: number, sessions: number) => void
    now?: () => number
}

interface ScreenRead {
    busy: boolean
    question: string | null
    readAt: number
}

export class SessionScreenStatusPoller {
    private timer: ReturnType<typeof setInterval> | null = null
    private readonly reads = new Map<string, ScreenRead>()
    private readonly shown = new Map<string, SessionScreenStatus>()

    constructor(private readonly deps: Deps) {}

    get running(): boolean {
        return this.timer !== null
    }

    start(): void {
        if (this.timer) return
        this.deps.publish({ enabled: true, reset: true, changes: [] })
        this.timer = setInterval(() => this.tick(), SESSION_SCREEN_STATUS_INTERVAL_MS)
        this.tick()
    }

    stop(): void {
        if (!this.timer) return
        clearInterval(this.timer)
        this.timer = null
        this.reads.clear()
        this.shown.clear()
        this.deps.publish({ enabled: false, reset: true, changes: [] })
    }

    /** What a window that just (re)loaded should show. */
    snapshot(): SessionScreenStatusMessage {
        return { enabled: this.running, reset: true, changes: [...this.shown.values()] }
    }

    /** One pass over every session. Public for tests; returns what changed. */
    tick(): SessionScreenStatus[] {
        const started = performance.now()
        const now = this.deps.now?.() ?? Date.now()
        const ids = this.deps.mirror.ids()
        const changes: SessionScreenStatus[] = []

        for (const id of ids) {
            const next = this.judge(id, now)
            const prev = this.shown.get(id)
            if (next.state === 'idle') {
                if (prev) {
                    this.shown.delete(id)
                    changes.push(next)
                }
                continue
            }
            if (!prev || prev.state !== next.state || prev.question !== next.question) {
                this.shown.set(id, next)
                changes.push(next)
            }
        }

        // Closed sessions lose their mirror; drop their dot with them.
        const live = new Set(ids)
        for (const id of [...this.shown.keys()]) {
            if (live.has(id)) continue
            this.shown.delete(id)
            changes.push({ sessionId: id, state: 'idle' })
        }
        for (const id of [...this.reads.keys()]) {
            if (!live.has(id)) this.reads.delete(id)
        }

        if (changes.length > 0) this.deps.publish({ enabled: true, reset: false, changes })
        this.deps.onTick?.(performance.now() - started, ids.length)
        return changes
    }

    private judge(id: string, now: number): SessionScreenStatus {
        if (this.deps.mirror.hasExited(id)) return { sessionId: id, state: 'idle' }

        let read = this.reads.get(id)
        if (!read || this.deps.mirror.lastOutputAt(id) >= read.readAt - PARSE_SETTLE_MS) {
            read = { ...this.deps.mirror.screenStatus(id), readAt: now }
            this.reads.set(id, read)
        }

        const hook = this.deps.hookStatus(id)
        if (read.question !== null || hook?.awaitingInput === true) {
            const question = read.question ?? hook?.detail
            return question ? { sessionId: id, state: 'waiting', question } : { sessionId: id, state: 'waiting' }
        }
        const state: SessionScreenState = read.busy || (hook?.source === 'hook' && hook.status === 'running') ? 'working' : 'idle'
        return { sessionId: id, state }
    }
}
