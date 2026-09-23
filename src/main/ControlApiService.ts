import { existsSync, realpathSync, statSync } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import {
    AgentStatusUpdate,
    ControlApiSessionEvent,
    TerminalSession,
    TerminalTemplate,
    Workspace
} from '../shared/types'
import { TerminalManager } from './TerminalManager'
import { TerminalMirror } from './TerminalMirror'

/**
 * What the Control API can do, independent of transport. The HTTP routes and
 * the MCP tools are both thin adapters over this class.
 *
 * Access rule: the API reads the workspace list and templates, but it may only
 * type into and read sessions carrying `aiControl` — the ones it opened. The
 * user's own terminals stay out of reach, and "Disconnect AI" in the sidebar
 * clears the flag, which is how a session is taken back.
 */

/** Output-silence that counts as "settled" when nothing else says the agent is busy. */
const DEFAULT_QUIET_MS = 1500

/** How long to wait for the renderer to spawn a new session's pty. */
const PTY_START_TIMEOUT_MS = 15_000

/**
 * Before a first prompt is typed, the start command must be running and done
 * drawing. Output silence alone is not enough: a heavy shell profile can take
 * seconds to print its first prompt, and silence during that time once let a
 * prompt be typed ahead into the shell and land in the program's first dialog.
 */
const STARTUP_MIN_MS = 1_500
const STARTUP_QUIET_MS = 2_000
const STARTUP_TIMEOUT_MS = 60_000

const WAIT_POLL_MS = 200
const MAX_WAIT_MS = 10 * 60 * 1000

/**
 * Agent TUIs treat a burst of characters as a paste; an Enter inside that
 * burst becomes a newline instead of a submit. Waiting before Enter keeps the
 * two apart. Longer text takes the program longer to ingest.
 */
const SUBMIT_DELAY_BASE_MS = 150
const SUBMIT_DELAY_PER_CHAR_MS = 0.02
const SUBMIT_DELAY_MAX_MS = 1_500
const KEY_GAP_MS = 60

const MAX_OUTPUT_LINES = 2000
const DEFAULT_OUTPUT_LINES = 60
const MAX_TEXT_LENGTH = 100_000

/** Named keys an agent may press. Anything else must be a single literal character. */
export const NAMED_KEYS: Record<string, string> = {
    enter: '\r',
    escape: '\x1b',
    esc: '\x1b',
    tab: '\t',
    'shift-tab': '\x1b[Z',
    backspace: '\x7f',
    space: ' ',
    up: '\x1b[A',
    down: '\x1b[B',
    right: '\x1b[C',
    left: '\x1b[D',
    'ctrl-c': '\x03',
    'ctrl-d': '\x04',
    'ctrl-l': '\x0c',
    'ctrl-u': '\x15'
}

export type SessionState = 'starting' | 'busy' | 'idle' | 'exited'

export class ControlApiError extends Error {
    constructor(
        readonly status: number,
        readonly code: string,
        message: string
    ) {
        super(message)
    }
}

export interface ApiWorkspace {
    id: string
    name: string
    path: string
    kind: 'home' | 'playground' | 'worktree' | 'folder'
    branchName?: string
    sessionCount: number
    aiSessionCount: number
}

export interface ApiTemplate {
    id: string
    name: string
    command: string
    description: string
}

export interface ApiSession {
    id: string
    name: string
    workspaceId: string
    workspaceName: string
    cwd: string
    command: string | null
    state: SessionState
    awaitingInput: boolean
    controlledBy: string
    connectedAt: string
}

export interface ApiOutput {
    session: ApiSession
    mode: 'screen' | 'tail'
    cols: number | null
    rows: number | null
    lines: string[]
}

export interface ApiWaitResult extends ApiOutput {
    timedOut: boolean
    waitedMs: number
}

export interface OpenSessionInput {
    path?: string
    workspaceId?: string
    template?: string
    command?: string
    name?: string
    focus?: boolean
    prompt?: string
    client: string
}

export interface OpenSessionResult {
    session: ApiSession
    createdWorkspace: boolean
    terminalStarted: boolean
    promptSent: boolean
    note?: string
}

export interface SendInputInput {
    text?: string
    submit?: boolean
    keys?: string[]
    /** Send text even though the screen shows a question. */
    force?: boolean
}

export interface WaitInput {
    timeoutMs?: number
    quietMs?: number
    lines?: number
    signal?: AbortSignal
}

export interface ControlApiDeps {
    // electron-store has no usable generic type in this codebase (see index.ts)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: any
    terminals: TerminalManager
    mirror: TerminalMirror
    broadcast: (channel: string, payload: unknown) => void
    hookStatus: (terminalId: string) => AgentStatusUpdate | null
}

export const CONTROL_API_SESSION_CHANNEL = 'control-api-session'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function canonicalPath(p: string): string {
    const resolved = path.resolve(p)
    try {
        // macOS: /tmp and /var are symlinks into /private. Comparing realpaths
        // keeps the API from registering a second workspace for the same folder.
        return realpathSync(resolved)
    } catch {
        return resolved
    }
}

export class ControlApiService {
    constructor(private readonly deps: ControlApiDeps) {}

    /**
     * Starts mirroring the sessions a previous run left flagged. Called when the
     * server starts, never before: a mirror parses every byte its terminal
     * prints, and that cost must not exist while the API is switched off.
     */
    startMirroring(): void {
        for (const { session } of this.aiSessions()) this.deps.mirror.attach(session.id)
    }

    /** Stops all mirroring. The sessions keep their flag, so enabling resumes them. */
    stopMirroring(): void {
        this.deps.mirror.disposeAll()
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    listWorkspaces(query?: string): ApiWorkspace[] {
        const needle = query?.trim().toLowerCase()
        return this.workspaces()
            .filter((w) => !needle || w.name.toLowerCase().includes(needle) || w.path.toLowerCase().includes(needle))
            .map((w) => ({
                id: w.id,
                name: w.name,
                path: w.path,
                kind: w.isHome ? 'home' : w.isPlayground ? 'playground' : w.parentWorkspaceId ? 'worktree' : 'folder',
                ...(w.branchName ? { branchName: w.branchName } : {}),
                sessionCount: w.sessions?.length ?? 0,
                aiSessionCount: (w.sessions ?? []).filter((s) => s.aiControl).length
            }))
    }

    listTemplates(): ApiTemplate[] {
        const templates = (this.deps.store.get('customTemplates') as TerminalTemplate[] | undefined) ?? []
        return templates.map((t) => ({ id: t.id, name: t.name, command: t.command, description: t.description ?? '' }))
    }

    listSessions(): ApiSession[] {
        return this.aiSessions().map(({ workspace, session }) => this.describe(workspace, session))
    }

    getSession(sessionId: string): ApiSession {
        const { workspace, session } = this.requireControlled(sessionId)
        return this.describe(workspace, session)
    }

    async readOutput(sessionId: string, options: { lines?: number; mode?: 'screen' | 'tail' } = {}): Promise<ApiOutput> {
        const { workspace, session } = this.requireControlled(sessionId)
        await this.deps.mirror.flush(sessionId)
        const mode = options.mode ?? 'screen'
        const lines = clampLines(options.lines)
        const size = this.deps.mirror.size(sessionId)
        const screen = mode === 'tail'
            ? this.deps.mirror.tail(sessionId, lines)
            : this.deps.mirror.screen(sessionId).slice(-lines)
        return {
            session: this.describe(workspace, session),
            mode,
            cols: size?.cols ?? null,
            rows: size?.rows ?? null,
            lines: screen
        }
    }

    // ------------------------------------------------------------------
    // Session lifecycle
    // ------------------------------------------------------------------

    async openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
        const command = this.resolveCommand(input.template, input.command)
        const { workspace, created } = this.resolveWorkspace(input.workspaceId, input.path)

        const templateName = input.template ? this.findTemplate(input.template)?.name : undefined
        const session: TerminalSession = {
            id: uuidv4(),
            name: (input.name?.trim() || templateName || 'AI Terminal').slice(0, 80),
            cwd: workspace.path,
            type: 'regular',
            ...(command ? { initialCommand: command } : {}),
            aiControl: { client: input.client, since: Date.now() }
        }

        // Mirror first so the very first bytes the shell prints are captured.
        this.deps.mirror.attach(session.id)

        const workspaces = this.workspaces()
        if (created) {
            workspaces.push({ ...workspace, sessions: [session] })
        } else {
            const target = workspaces.find((w) => w.id === workspace.id)!
            target.sessions = [...(target.sessions ?? []), session]
        }
        this.deps.store.set('workspaces', workspaces)

        this.emit({
            type: 'opened',
            workspaceId: workspace.id,
            sessionId: session.id,
            session,
            ...(created ? { workspace: { ...workspace, sessions: [session] } } : {}),
            focus: input.focus === true
        })

        const terminalStarted = await this.waitForPty(session.id, PTY_START_TIMEOUT_MS)
        const result: OpenSessionResult = {
            session: this.getSession(session.id),
            createdWorkspace: created,
            terminalStarted,
            promptSent: false
        }

        if (!terminalStarted) {
            result.note = 'The session was added but CLI Manager did not start its terminal yet. Is the main window open?'
            return result
        }

        if (input.prompt?.trim()) {
            const ready = await this.waitForStartup(session.id, command !== undefined)
            if (!ready) {
                result.note =
                    'The program did not finish starting within a minute, so the prompt was not sent. ' +
                    'Read the screen, then send the prompt with send_input.'
            } else if (this.deps.mirror.showsAwaitingInput(session.id)) {
                result.note =
                    'The program is asking a question (for example whether to trust this folder), so the prompt was not sent. ' +
                    'Read the screen, answer it with send_input keys (e.g. ["down","enter"]), then send the prompt.'
            } else {
                await this.sendInput(session.id, { text: input.prompt, submit: true })
                result.promptSent = true
            }
            result.session = this.getSession(session.id)
        }

        return result
    }

    async sendInput(sessionId: string, input: SendInputInput): Promise<ApiSession> {
        const { workspace, session } = this.requireControlled(sessionId)
        const keys = (input.keys ?? []).map((key) => resolveKey(key))

        if (input.text === undefined && keys.length === 0) {
            throw new ControlApiError(400, 'bad_request', 'Provide text, keys, or both.')
        }
        if (input.text !== undefined && input.text.length > MAX_TEXT_LENGTH) {
            throw new ControlApiError(413, 'too_large', `text is limited to ${MAX_TEXT_LENGTH} characters.`)
        }

        if (!(await this.waitForPty(sessionId, PTY_START_TIMEOUT_MS))) {
            throw new ControlApiError(409, 'not_started', 'The terminal for this session is not running.')
        }
        if (this.deps.mirror.hasExited(sessionId)) {
            throw new ControlApiError(409, 'exited', 'The shell in this session has exited. Close it and open a new one.')
        }

        if (input.text !== undefined && !input.force) {
            await this.deps.mirror.flush(sessionId)
            if (this.deps.mirror.showsAwaitingInput(sessionId)) {
                throw new ControlApiError(
                    409,
                    'awaiting_input',
                    'The screen shows a question or menu, where Enter would pick the highlighted option. ' +
                        'Read the screen and answer with keys, or pass force: true to type text anyway.'
                )
            }
        }

        if (input.text !== undefined) {
            const submit = input.submit !== false
            const text = submit ? input.text.replace(/[\r\n]+$/, '') : input.text
            if (text.length > 0) {
                this.deps.terminals.writeInput(sessionId, this.encodeText(sessionId, text))
            }
            if (submit) {
                await sleep(submitDelay(text.length))
                this.deps.terminals.writeInput(sessionId, '\r')
            }
        }

        for (const key of keys) {
            await sleep(KEY_GAP_MS)
            this.deps.terminals.writeInput(sessionId, key)
        }

        return this.describe(workspace, session)
    }

    /**
     * Waits until the session settles: no output for `quietMs`, no
     * "esc to interrupt" on screen, and no hook saying a turn is running.
     * Returns the screen either way, flagged `timedOut` when it never settled.
     */
    async waitForIdle(sessionId: string, input: WaitInput = {}): Promise<ApiWaitResult> {
        this.requireControlled(sessionId)
        const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 0), MAX_WAIT_MS)
        const quietMs = Math.max(input.quietMs ?? DEFAULT_QUIET_MS, 200)
        const started = Date.now()

        let timedOut = false
        for (;;) {
            await this.deps.mirror.flush(sessionId)
            const state = this.stateOf(sessionId, quietMs)
            // At least one quiet window after the call starts, so a wait issued
            // right after send_input cannot return before the agent reacted.
            const settled = (state === 'idle' && Date.now() - started >= quietMs) || state === 'exited'
            if (settled) break
            if (input.signal?.aborted) break
            if (Date.now() - started >= timeoutMs) {
                timedOut = true
                break
            }
            await sleep(WAIT_POLL_MS)
            // The session may be closed or released while we wait.
            this.requireControlled(sessionId)
        }

        const output = await this.readOutput(sessionId, { lines: input.lines, mode: 'screen' })
        return { ...output, timedOut, waitedMs: Date.now() - started }
    }

    focusSession(sessionId: string): ApiSession {
        const { workspace, session } = this.requireControlled(sessionId)
        this.emit({ type: 'focus', workspaceId: workspace.id, sessionId })
        return this.describe(workspace, session)
    }

    /** Hands the session to the user: it keeps running, the API loses access. */
    releaseSession(sessionId: string): void {
        this.requireControlled(sessionId)
        this.clearAiControl(sessionId)
    }

    closeSession(sessionId: string): void {
        const { workspace } = this.requireControlled(sessionId)
        this.deps.terminals.killTerminal(sessionId)
        this.deps.mirror.detach(sessionId)

        const workspaces = this.workspaces()
        const target = workspaces.find((w) => w.id === workspace.id)
        if (target) target.sessions = target.sessions.filter((s) => s.id !== sessionId)
        this.deps.store.set('workspaces', workspaces)

        this.emit({ type: 'closed', workspaceId: workspace.id, sessionId })
    }

    // ------------------------------------------------------------------
    // Hooks for the rest of the app
    // ------------------------------------------------------------------

    /** Sidebar "Disconnect AI". Returns false when the session was not under AI control. */
    clearAiControl(sessionId: string): boolean {
        const workspaces = this.workspaces()
        for (const workspace of workspaces) {
            const session = workspace.sessions?.find((s) => s.id === sessionId)
            if (!session?.aiControl) continue
            delete session.aiControl
            this.deps.store.set('workspaces', workspaces)
            this.deps.mirror.detach(sessionId)
            this.emit({ type: 'updated', workspaceId: workspace.id, sessionId, session: { ...session } })
            return true
        }
        return false
    }

    /** The user deleted a session or workspace; drop what we held for it. */
    forgetSession(sessionId: string): void {
        this.deps.mirror.detach(sessionId)
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private workspaces(): Workspace[] {
        return ((this.deps.store.get('workspaces') as Workspace[] | undefined) ?? []).map((w) => ({
            ...w,
            sessions: w.sessions ?? []
        }))
    }

    private aiSessions(): Array<{ workspace: Workspace; session: TerminalSession }> {
        return this.workspaces().flatMap((workspace) =>
            workspace.sessions.filter((s) => s.aiControl).map((session) => ({ workspace, session }))
        )
    }

    private requireControlled(sessionId: string): { workspace: Workspace; session: TerminalSession } {
        for (const workspace of this.workspaces()) {
            const session = workspace.sessions.find((s) => s.id === sessionId)
            if (!session) continue
            if (!session.aiControl) {
                throw new ControlApiError(
                    403,
                    'not_controlled',
                    'This session is not under AI control. Only sessions opened through the API are accessible, and the user may disconnect them.'
                )
            }
            return { workspace, session }
        }
        throw new ControlApiError(404, 'not_found', `No session with id ${sessionId}. It may have been closed.`)
    }

    private findTemplate(nameOrId: string): TerminalTemplate | undefined {
        const templates = (this.deps.store.get('customTemplates') as TerminalTemplate[] | undefined) ?? []
        const needle = nameOrId.trim().toLowerCase()
        return templates.find((t) => t.id === nameOrId) ?? templates.find((t) => t.name.trim().toLowerCase() === needle)
    }

    private resolveCommand(template?: string, command?: string): string | undefined {
        if (template && command) {
            throw new ControlApiError(400, 'bad_request', 'Pass either template or command, not both.')
        }
        if (template) {
            const found = this.findTemplate(template)
            if (!found) {
                const names = this.listTemplates().map((t) => t.name).join(', ') || 'none'
                throw new ControlApiError(404, 'template_not_found', `No template named "${template}". Available: ${names}.`)
            }
            return found.command.trim() || undefined
        }
        return command?.trim() || undefined
    }

    private resolveWorkspace(workspaceId?: string, folder?: string): { workspace: Workspace; created: boolean } {
        const workspaces = this.workspaces()

        if (workspaceId) {
            const found = workspaces.find((w) => w.id === workspaceId)
            if (!found) throw new ControlApiError(404, 'workspace_not_found', `No workspace with id ${workspaceId}.`)
            return { workspace: found, created: false }
        }

        if (!folder) throw new ControlApiError(400, 'bad_request', 'Pass path (a folder) or workspaceId.')
        if (!path.isAbsolute(folder)) throw new ControlApiError(400, 'bad_request', 'path must be absolute.')
        if (!existsSync(folder) || !statSync(folder).isDirectory()) {
            throw new ControlApiError(404, 'folder_not_found', `Folder does not exist: ${folder}`)
        }

        const target = canonicalPath(folder)
        const existing = workspaces.find((w) => canonicalPath(w.path) === target)
        if (existing) return { workspace: existing, created: false }

        const resolved = path.resolve(folder)
        return {
            workspace: {
                id: uuidv4(),
                name: path.basename(resolved) || resolved,
                path: resolved,
                sessions: [],
                createdAt: Date.now()
            },
            created: true
        }
    }

    private stateOf(sessionId: string, quietMs: number): SessionState {
        // A shell that exits on its own stays registered in TerminalManager, so
        // the exit event is the only reliable signal.
        if (this.deps.mirror.hasExited(sessionId)) return 'exited'
        if (!this.deps.terminals.hasTerminal(sessionId)) return 'starting'
        const hook = this.deps.hookStatus(sessionId)
        const recentOutput = Date.now() - this.deps.mirror.lastOutputAt(sessionId) < quietMs
        if (recentOutput || this.deps.mirror.showsBusy(sessionId) || (hook?.source === 'hook' && hook.status === 'running')) {
            return 'busy'
        }
        return 'idle'
    }

    private describe(workspace: Workspace, session: TerminalSession): ApiSession {
        const hook = this.deps.hookStatus(session.id)
        return {
            id: session.id,
            name: session.name,
            workspaceId: workspace.id,
            workspaceName: workspace.name,
            cwd: session.cwd,
            command: session.initialCommand ?? null,
            state: this.stateOf(session.id, DEFAULT_QUIET_MS),
            awaitingInput: this.deps.mirror.showsAwaitingInput(session.id) || hook?.awaitingInput === true,
            controlledBy: session.aiControl?.client ?? '',
            connectedAt: new Date(session.aiControl?.since ?? 0).toISOString()
        }
    }

    private encodeText(sessionId: string, text: string): string {
        if (!/[\r\n]/.test(text)) return text
        // Multi-line text: a program that asked for bracketed paste receives it
        // as one paste (Claude Code keeps it as a single prompt). Anything else
        // gets carriage returns, which is what pressing Enter per line sends.
        if (this.deps.mirror.bracketedPaste(sessionId)) {
            return `\x1b[200~${text.replace(/\r\n?/g, '\n')}\x1b[201~`
        }
        return text.replace(/\r?\n/g, '\r')
    }

    private waitForPty(sessionId: string, timeoutMs: number): Promise<boolean> {
        if (this.deps.terminals.hasTerminal(sessionId)) return Promise.resolve(true)
        return new Promise((resolve) => {
            const onCreated = (id: string): void => {
                if (id !== sessionId) return
                cleanup()
                resolve(true)
            }
            const timer = setTimeout(() => {
                cleanup()
                resolve(this.deps.terminals.hasTerminal(sessionId))
            }, timeoutMs)
            const cleanup = (): void => {
                clearTimeout(timer)
                this.deps.terminals.events.off('created', onCreated)
            }
            this.deps.terminals.events.on('created', onCreated)
        })
    }

    /**
     * Lets the start command launch and draw before anything is typed into it.
     * With a command, "started" means the shell has a child process; the quiet
     * window is then measured from that moment, never from before it.
     */
    private async waitForStartup(sessionId: string, expectCommand: boolean): Promise<boolean> {
        await sleep(STARTUP_MIN_MS)
        const started = Date.now()
        let programSeenAt = 0
        while (Date.now() - started < STARTUP_TIMEOUT_MS) {
            if (expectCommand) {
                if (!(await this.deps.terminals.hasChildProcess(sessionId))) {
                    programSeenAt = 0
                    await sleep(WAIT_POLL_MS)
                    continue
                }
                programSeenAt ||= Date.now()
            }
            await this.deps.mirror.flush(sessionId)
            const quietSince = Math.max(this.deps.mirror.lastOutputAt(sessionId), programSeenAt)
            if (Date.now() - quietSince >= STARTUP_QUIET_MS && !this.deps.mirror.showsBusy(sessionId)) return true
            await sleep(WAIT_POLL_MS)
        }
        return false
    }

    private emit(event: ControlApiSessionEvent): void {
        this.deps.broadcast(CONTROL_API_SESSION_CHANNEL, event)
    }
}

function clampLines(lines?: number): number {
    if (!lines || !Number.isFinite(lines)) return DEFAULT_OUTPUT_LINES
    return Math.min(Math.max(Math.floor(lines), 1), MAX_OUTPUT_LINES)
}

function submitDelay(length: number): number {
    return Math.min(SUBMIT_DELAY_BASE_MS + length * SUBMIT_DELAY_PER_CHAR_MS, SUBMIT_DELAY_MAX_MS)
}

function resolveKey(key: string): string {
    const named = NAMED_KEYS[key.toLowerCase()]
    if (named !== undefined) return named
    if ([...key].length === 1) return key
    throw new ControlApiError(
        400,
        'bad_key',
        `Unknown key "${key}". Use a single character or one of: ${Object.keys(NAMED_KEYS).join(', ')}.`
    )
}
