/**
 * LoopManager.ts
 *
 * Owns all Loop Dashboard state: projects promoted from workspaces, terminal
 * sessions running Claude Code /loop, and the activity detector that drives
 * LoopCounter.
 *
 * Responsibilities:
 *  - Persist LoopProject[] and LoopSession[] to electron-store.
 *  - Detect "running" / "ready" / "stopped" transitions from raw PTY output
 *    via the TerminalManager.onOutput hook.
 *  - Feed status transitions and raw output to LoopCounter for iteration
 *    counting.
 *  - Broadcast LoopUpdatePayload to the Loop Dashboard window whenever state
 *    changes.
 *
 * Architecture note: LoopManager does NOT spawn PTY processes.  The renderer's
 * TerminalView mounts with the session's terminalId and calls the existing
 * 'terminal-create' IPC handler — exactly the same flow as the main app.
 * LoopManager only manages the record, counter, and activity timers.
 */

import { v4 as uuidv4 } from 'uuid'
import type { CLISessionTracker } from './CLISessionTracker'
import { LoopCounter } from './LoopCounter'
import type { TerminalManager } from './TerminalManager'
import type {
    LoopDetectionConfig,
    LoopProject,
    LoopSession,
    LoopState,
    LoopStatus,
    LoopUpdatePayload,
    UserSettings,
    Workspace,
} from '../shared/types'
import { DEFAULT_LOOP_DETECTION } from '../shared/types'

// ---------------------------------------------------------------------------
// Activity-detection constants
// ---------------------------------------------------------------------------

/**
 * How long (ms) PTY output must be absent before we consider the current
 * iteration "settled" (running → ready transition).  1.5 s absorbs momentary
 * gaps in streaming output without prematurely declaring the turn complete.
 */
const QUIET_READY_MS = 1500

/**
 * How long (ms) of total silence before we assume the loop/terminal has
 * stopped (e.g. the user killed claude or the process exited).  This is a
 * heuristic: 2 minutes of complete silence ⇒ declare 'stopped'.  A manual
 * restart (via the Loop Dashboard restart button) resets the session back to
 * 'ready' immediately.
 */
const STOPPED_IDLE_MS = 120_000

/** Cap on how many recent iteration timestamps we keep per session (for the stats timeline). */
const MAX_RECENT_LOOPS = 50

// ---------------------------------------------------------------------------
// LoopManager
// ---------------------------------------------------------------------------

export class LoopManager {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly store: any  // electron-store instance (cast as any to avoid Conf<> type resolution issues)
    private readonly terminalManager: TerminalManager
    private readonly cliSessionTracker: CLISessionTracker
    private readonly broadcast: (payload: LoopUpdatePayload) => void
    private readonly loopCounter: LoopCounter
    /** Current detection config (mirrors LoopCounter; also drives the idle timer). */
    private config: LoopDetectionConfig

    /** Per-terminal quiet timers: fire after QUIET_READY_MS of silence → ready */
    private readonly quietTimers = new Map<string, NodeJS.Timeout>()

    /** Per-terminal idle timers: fire after STOPPED_IDLE_MS of silence → stopped */
    private readonly idleTimers = new Map<string, NodeJS.Timeout>()

    constructor(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store: any,  // electron-store instance
        terminalManager: TerminalManager,
        cliSessionTracker: CLISessionTracker,
        broadcast: (payload: LoopUpdatePayload) => void,
    ) {
        this.store = store
        this.terminalManager = terminalManager
        this.cliSessionTracker = cliSessionTracker
        this.broadcast = broadcast

        // Build LoopCounter with persisted config and an onIteration callback.
        const config = this.loadConfig()
        this.config = config
        this.loopCounter = new LoopCounter(config, (ev) => {
            // Called by LoopCounter each time a debounced iteration is confirmed.
            const sessions = this.loadSessions()
            const session = sessions.find((s) => s.terminalId === ev.terminalId)
            if (!session) return

            session.loopCount = ev.index
            session.lastLoopAt = ev.at
            // Append to the iteration timeline (capped, newest last) for the stats modal.
            const history = session.recentLoops ?? []
            history.push({ index: ev.index, at: ev.at })
            if (history.length > MAX_RECENT_LOOPS) {
                history.splice(0, history.length - MAX_RECENT_LOOPS)
            }
            session.recentLoops = history
            // Status stays 'running' during iteration — status transitions are
            // handled separately by the activity detector.
            this.saveSessions(sessions)
            this.broadcast({ state: this.buildState(sessions) })
        })

        // Register ourselves as the raw-output observer on TerminalManager.
        // Only one observer can be set at a time; this is safe because nothing
        // else assigns onOutput in this codebase.
        this.terminalManager.onOutput = (id, data) => this.handleOutput(id, data)

        // Re-register all persisted loop sessions with the counter so they
        // survive app restarts.
        for (const session of this.loadSessions()) {
            this.loopCounter.registerSession(session.terminalId)
        }
    }

    // -------------------------------------------------------------------------
    // Activity detector
    // -------------------------------------------------------------------------

    /**
     * Called for every raw PTY output chunk.  Only processes chunks whose
     * terminal id belongs to a known LoopSession.
     *
     * State machine per terminal:
     *   any output  → status = 'running' (if not already), reset quiet + idle timers
     *   quiet timer fires (QUIET_READY_MS) → status = 'ready' (triggers LoopCounter settle)
     *   idle  timer fires (STOPPED_IDLE_MS) → status = 'stopped'
     */
    private handleOutput(id: string, data: string): void {
        const sessions = this.loadSessions()
        const session = sessions.find((s) => s.terminalId === id)
        if (!session) return

        const now = Date.now()

        // Feed raw output to LoopCounter (supports customPattern mode).
        this.loopCounter.recordOutput(id, data, now)

        // Transition to 'running' on the leading edge of output.
        if (session.status !== 'running') {
            session.status = 'running'
            session.statusSince = now
            this.saveSessions(sessions)
            this.loopCounter.recordStatus(id, 'running', now)
            this.broadcast({ state: this.buildState(sessions) })
        }

        // Reset quiet timer — cancel any pending 'ready' transition.
        const existingQuiet = this.quietTimers.get(id)
        if (existingQuiet) clearTimeout(existingQuiet)

        const quietTimer = setTimeout(() => {
            this.quietTimers.delete(id)
            // Output has been quiet for QUIET_READY_MS → declare ready.
            const current = this.loadSessions()
            const s = current.find((x) => x.terminalId === id)
            if (!s || s.status === 'stopped') return

            s.status = 'ready'
            s.statusSince = Date.now()
            this.saveSessions(current)
            this.loopCounter.recordStatus(id, 'ready', Date.now())
            this.broadcast({ state: this.buildState(current) })
        }, QUIET_READY_MS)
        this.quietTimers.set(id, quietTimer)

        // Reset idle timer — cancel any pending 'stopped' transition.
        const existingIdle = this.idleTimers.get(id)
        if (existingIdle) clearTimeout(existingIdle)

        const idleTimer = setTimeout(() => {
            this.idleTimers.delete(id)
            // 2 min of total silence → declare stopped.
            const current = this.loadSessions()
            const s = current.find((x) => x.terminalId === id)
            if (!s) return

            s.status = 'stopped'
            s.statusSince = Date.now()
            this.saveSessions(current)
            this.loopCounter.recordStatus(id, 'stopped', Date.now())
            this.broadcast({ state: this.buildState(current) })
        }, this.config.stoppedIdleMs ?? STOPPED_IDLE_MS)
        this.idleTimers.set(id, idleTimer)
    }

    // -------------------------------------------------------------------------
    // Public API — called by IPC handlers in index.ts
    // -------------------------------------------------------------------------

    /** Return the current LoopState snapshot. */
    getState(): LoopState {
        return this.buildState(this.loadSessions())
    }

    /**
     * Promote a workspace to a LoopProject.  Idempotent: if a project already
     * exists for the same sourceWorkspaceId, returns the existing state.
     */
    promote(workspaceId: string): LoopState {
        const workspaces = (this.store.get('workspaces') || []) as Workspace[]
        const workspace = workspaces.find((w) => w.id === workspaceId)
        if (!workspace) {
            return this.getState()
        }

        const projects = this.loadProjects()
        const existing = projects.find((p) => p.sourceWorkspaceId === workspaceId)
        if (existing) {
            return this.buildState(this.loadSessions())
        }

        const newProject: LoopProject = {
            id: uuidv4(),
            name: workspace.name,
            path: workspace.path,
            sourceWorkspaceId: workspace.id,
            createdAt: Date.now(),
        }

        projects.push(newProject)
        this.saveProjects(projects)

        const state = this.buildState(this.loadSessions())
        this.broadcast({ state })
        return state
    }

    /**
     * Create (or return the existing) LoopSession for the given LoopProject.
     *
     * NOTE: this method only creates the session RECORD.  The renderer is
     * responsible for mounting a TerminalView with session.terminalId, which
     * will call 'terminal-create' via IPC — the same flow as the main window.
     */
    openTerminal(loopProjectId: string): LoopSession | null {
        const projects = this.loadProjects()
        const project = projects.find((p) => p.id === loopProjectId)
        if (!project) return null

        const sessions = this.loadSessions()

        // One session per project for v1 — return existing if present.
        const existing = sessions.find((s) => s.loopProjectId === loopProjectId)
        if (existing) {
            this.broadcast({ state: this.buildState(sessions) })
            return existing
        }

        const terminalId = uuidv4()
        const now = Date.now()
        const newSession: LoopSession = {
            id: uuidv4(),
            loopProjectId,
            terminalId,
            cliToolName: 'claude',
            status: 'ready',
            loopCount: 0,
            lastLoopAt: null,
            startedAt: now,
            statusSince: now,
            recentLoops: [],
        }

        this.loopCounter.registerSession(terminalId)
        sessions.push(newSession)
        this.saveSessions(sessions)

        const state = this.buildState(sessions)
        this.broadcast({ state })
        return newSession
    }

    /**
     * Restart a stopped (or running) loop session.  Resets the iteration
     * counter and sends a resume or fresh-start command to the PTY.
     */
    restart(loopSessionId: string): LoopSession | null {
        const sessions = this.loadSessions()
        const session = sessions.find((s) => s.id === loopSessionId)
        if (!session) return null

        // #1 Cancel any stale activity timers first — otherwise a quiet/idle
        // timer set before the restart can fire afterward and wrongly flip the
        // freshly-restarted session to 'stopped' or emit a stale settle.
        this.clearTimers(session.terminalId)

        // Reset counter state for this terminal (re-arms skip-first too).
        this.loopCounter.reset(session.terminalId)

        session.loopCount = 0
        session.lastLoopAt = null
        session.status = 'ready'
        session.statusSince = Date.now()
        session.recentLoops = []

        // Build the relaunch command.
        //  - If a cliSessionId was captured, resume that conversation.
        //  - Otherwise rewrite a fresh `claude` through CLISessionTracker so a
        //    --session-id is injected AND captured, enabling --resume on later
        //    restarts (a bare write would bypass the tracker and never get one).
        let command: string
        if (session.cliSessionId) {
            command = `claude --resume ${session.cliSessionId}`
        } else {
            const rewritten = this.cliSessionTracker.rewriteCommand('claude')
            if (rewritten) {
                command = rewritten.command
                session.cliSessionId = rewritten.cliSessionId
                session.cliToolName = rewritten.cliToolName
            } else {
                command = 'claude'
            }
        }

        // Send to the PTY.  Wrapped in try/catch because the PTY may be gone.
        // A leading Ctrl-C clears any partial shell input before the command.
        // (Restart targets stopped sessions; if claude is unexpectedly still
        // alive, Ctrl-C interrupts its current turn rather than corrupting it.)
        try {
            this.terminalManager.writeToTerminal(session.terminalId, '\x03')
            this.terminalManager.writeToTerminal(session.terminalId, `${command}\r`)
        } catch (e) {
            console.warn(`[LoopManager] restart: PTY write failed for ${session.terminalId}:`, e)
        }

        this.saveSessions(sessions)
        const state = this.buildState(sessions)
        this.broadcast({ state })
        return session
    }

    /**
     * Remove a LoopProject and all its associated sessions from the dashboard.
     * Unregisters their terminals from LoopCounter and clears activity timers.
     */
    remove(loopProjectId: string): LoopState {
        const projects = this.loadProjects()
        const sessions = this.loadSessions()

        // Identify sessions that belong to this project.
        const removedSessions = sessions.filter((s) => s.loopProjectId === loopProjectId)

        for (const s of removedSessions) {
            this.loopCounter.unregister(s.terminalId)
            this.clearTimers(s.terminalId)
        }

        const updatedProjects = projects.filter((p) => p.id !== loopProjectId)
        const updatedSessions = sessions.filter((s) => s.loopProjectId !== loopProjectId)

        this.saveProjects(updatedProjects)
        this.saveSessions(updatedSessions)

        const state = this.buildState(updatedSessions)
        this.broadcast({ state })
        return state
    }

    /** Read the current LoopDetectionConfig from settings. */
    getConfig(): LoopDetectionConfig {
        return this.loadConfig()
    }

    /**
     * Persist a new LoopDetectionConfig and propagate it to LoopCounter so
     * changes take effect immediately without a restart.
     */
    setConfig(config: LoopDetectionConfig): LoopDetectionConfig {
        const settings = (this.store.get('settings') || {}) as UserSettings
        settings.loopDetection = config
        this.store.set('settings', settings)
        this.config = config
        this.loopCounter.updateConfig(config)
        return config
    }

    /**
     * Called by the existing cliSessionTracker.onSessionDetected handler in
     * index.ts to attach a cliSessionId to the matching LoopSession (if any).
     * This enables --resume on restart.
     */
    noteCliSession(info: { terminalId: string; cliToolName: string; cliSessionId: string }): void {
        const sessions = this.loadSessions()
        const session = sessions.find((s) => s.terminalId === info.terminalId)
        if (!session) return

        session.cliSessionId = info.cliSessionId
        session.cliToolName = info.cliToolName
        this.saveSessions(sessions)
    }

    // -------------------------------------------------------------------------
    // Private helpers
    // -------------------------------------------------------------------------

    private buildState(sessions: LoopSession[]): LoopState {
        return { projects: this.loadProjects(), sessions }
    }

    private loadProjects(): LoopProject[] {
        return (this.store.get('loopProjects') || []) as LoopProject[]
    }

    private saveProjects(projects: LoopProject[]): void {
        this.store.set('loopProjects', projects)
    }

    private loadSessions(): LoopSession[] {
        return (this.store.get('loopSessions') || []) as LoopSession[]
    }

    private saveSessions(sessions: LoopSession[]): void {
        this.store.set('loopSessions', sessions)
    }

    private loadConfig(): LoopDetectionConfig {
        const settings = this.store.get('settings') as UserSettings | undefined
        return settings?.loopDetection ?? DEFAULT_LOOP_DETECTION
    }

    /** Cancel all pending activity timers for a terminal id. */
    private clearTimers(terminalId: string): void {
        const qt = this.quietTimers.get(terminalId)
        if (qt) { clearTimeout(qt); this.quietTimers.delete(terminalId) }
        const it = this.idleTimers.get(terminalId)
        if (it) { clearTimeout(it); this.idleTimers.delete(terminalId) }
    }
}
