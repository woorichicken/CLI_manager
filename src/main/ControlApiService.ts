import { existsSync, realpathSync, statSync } from 'fs'
import path from 'path'
import { v4 as uuidv4 } from 'uuid'
import {
    AgentStatusUpdate,
    Checklist,
    ControlApiMasters,
    InboxRequest,
    ControlApiSessionEvent,
    DEFAULT_CONTROL_API,
    OrchestratorInfo,
    SessionFolder,
    SessionPeek,
    TerminalSession,
    TerminalTemplate,
    UserSettings,
    Workspace,
    WorkspaceFolder
} from '../shared/types'
import { TerminalManager } from './TerminalManager'
import { TerminalMirror } from './TerminalMirror'
import { SessionRelations } from './SessionRelations'
import { SessionFolders, SESSION_FOLDERS_CHANNEL } from './SessionFolders'
import { checkInboxInput, InboxStore } from './InboxStore'
import { ChecklistStatus, ChecklistStore, checkChecklistInput, checkItemTexts, cleanText, isComplete } from './ChecklistStore'

/**
 * What the Control API can do, independent of transport. The HTTP routes and
 * the MCP tools are both thin adapters over this class.
 *
 * Access rule: while the API is switched on it reaches every session in the
 * app, including the ones the user opened (decision 0006). `aiControl` is no
 * longer a permission — it is the visible mark that an AI is working in a
 * session. Opening a session sets it, and so does the first read, input, wait
 * or focus on a session that does not carry it. "Disconnect AI" and
 * `release` clear the mark; switching the API off is what ends access.
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
 * A poll that comes back this much later than it asked to means the process
 * was not running — the machine slept. That time is taken out of a wait's
 * budget: otherwise every wait in flight times out the instant the lid opens.
 * Measured with the app frozen for 8s: a 5s wait returned timedOut after 8.3s.
 */
const SLEEP_GAP_MS = 5_000

/**
 * Agent TUIs treat a burst of characters as a paste; an Enter inside that
 * burst becomes a newline instead of a submit. Waiting before Enter keeps the
 * two apart. Longer text takes the program longer to ingest.
 */
const SUBMIT_DELAY_BASE_MS = 150
const SUBMIT_DELAY_PER_CHAR_MS = 0.02
const SUBMIT_DELAY_MAX_MS = 1_500
const KEY_GAP_MS = 60

/**
 * A fixed delay before Enter is not always enough: under heavy load (load
 * average ~40, six sessions at once) Claude Code left a long prompt sitting in
 * its input box. When the program draws an input box, the API checks that
 * Enter emptied it and presses Enter again if not. An extra Enter on an empty
 * box does nothing, so a late-but-successful submit is harmless.
 */
const SUBMIT_CONFIRM_MS = 3_000
const SUBMIT_CONFIRM_POLL_MS = 250
const SUBMIT_RETRIES = 2
/** Enough of the prompt to recognise it in the box, short enough not to wrap. */
const SUBMIT_HEAD_CHARS = 16

/**
 * Terminals read ESC followed quickly by a character as Alt+character, so text
 * sent right after an Escape key vanished. Node's readline waits 500ms before
 * deciding a lone ESC is a key press; waiting a little longer is on the safe side.
 */
const ESCAPE_SETTLE_MS = 600
const ESCAPE = '\x1b'

/**
 * An orchestrator (a session that opened others through the API) that has made
 * no API call for this long stops being shown as one. The agent in it has most
 * likely finished; a stale red row would claim otherwise.
 */
export const ORCHESTRATOR_IDLE_MS = 30 * 60 * 1000
const ORCHESTRATOR_SWEEP_MS = 60 * 1000

const MAX_OUTPUT_LINES = 2000
const DEFAULT_OUTPUT_LINES = 60
const MAX_TEXT_LENGTH = 100_000
/** Same cap open_session applies; the sidebar truncates long names anyway. */
const MAX_NAME_LENGTH = 80

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

export interface ApiFolderRef {
    id: string
    name: string
}

export interface ApiWorkspace {
    id: string
    name: string
    path: string
    kind: 'home' | 'playground' | 'worktree' | 'folder'
    branchName?: string
    sessionCount: number
    aiSessionCount: number
    /** Sidebar folder (group) it sits in, or null at the top level. */
    folder: ApiFolderRef | null
    /** 'ai' when the Control API registered it; only those can be unregistered through the API. */
    registeredBy: 'ai' | 'user'
    /** Client that registered it, or '' for 'user'. */
    registeredByClient: string
    /** Unregisters itself when its last session closes. */
    ephemeral: boolean
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
    /** Marked in the app as driven by an AI. False for a session no AI has touched (or that was released). */
    aiControlled: boolean
    /** Client that marked it, or '' when not marked. */
    controlledBy: string
    /** ISO time it was marked, or '' when not marked. */
    connectedAt: string
    /**
     * The screen copy started after the terminal was already running (the API
     * was switched on mid-session), so output from before that is missing.
     */
    screenPartial: boolean
    /** The session's memo pad (Cmd+J). Empty when the user wrote none. */
    memo: string
    /**
     * Set while this session is an orchestrator: it sent X-Caller-Session and
     * opened at least one session. Self-reported, so display only.
     */
    orchestrator: { since: string; lastSeen: string; client: string; openedCount: number } | null
    /** Id of the orchestrator session that opened this one, or null. */
    openedBy: string | null
    /** Session folder of the sidebar's All sessions view it sits in, or null. */
    sessionFolder: { id: string; name: string } | null
    /**
     * Every page of the memo pad, first page first — always at least one. `memoPages[0]` is `memo`.
     * (The store keeps pages from the second on in `memoPages`; this field counts from the first,
     * like the app's own page list.)
     */
    memoPages: string[]
}

export interface ApiSessionFolder {
    id: string
    name: string
    /** ISO time. */
    createdAt: string
    sessions: Array<{ id: string; name: string; workspaceName: string }>
}

export interface ApiRelation {
    sessionId: string
    name: string
    workspaceName: string
    kind: 'opened' | 'connected' | 'manual'
    /** 'outgoing': this session is the `from` of the pair (it opened or first used the other one). */
    direction: 'outgoing' | 'incoming'
    /** ISO time the pair was recorded. */
    at: string
}

export interface ApiOutput {
    session: ApiSession
    mode: 'screen' | 'tail'
    cols: number | null
    rows: number | null
    lines: string[]
    /**
     * Text the agent shows dimmed in its empty input box as a suggested next
     * prompt. It appears in `lines` too, but nobody typed it. Null when none.
     */
    suggestion: string | null
}

export interface ApiWaitResult extends ApiOutput {
    timedOut: boolean
    waitedMs: number
    /** Time the machine spent asleep during the wait; not counted against the timeout. */
    sleptMs: number
}

export interface ListSessionsInput {
    /** 'ai' (default): sessions marked as AI-driven. 'all': every session in the app. */
    scope?: 'ai' | 'all'
    /** Case-insensitive substring of the session name, workspace name or folder. */
    query?: string
}

export interface OpenSessionInput {
    path?: string
    workspaceId?: string
    template?: string
    command?: string
    name?: string
    focus?: boolean
    prompt?: string
    /**
     * Sidebar folder for a newly registered workspace: an existing folder's id
     * or name, or a new name (created). '' means top level. Omitted means the
     * folder named in Settings. Ignored when the workspace already exists.
     */
    folder?: string
    /** Session folder (id or name; made when no folder has the name) to put the new session in. */
    sessionFolder?: string
    /** Unregister the new workspace when its last session closes. Ignored when it already exists. */
    ephemeral?: boolean
    client: string
    /** Session id from X-Caller-Session: the session asking, if it said so. */
    caller?: string
}

export interface OpenSessionResult {
    session: ApiSession
    workspace: ApiWorkspace
    createdWorkspace: boolean
    /** A sidebar folder was created for the new workspace. */
    createdFolder: boolean
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
    /** Who is typing; recorded when this is the first touch of a session. */
    client?: string
    /** X-Caller-Session of the request, if it said who it was. */
    caller?: string
}

export interface WaitInput {
    timeoutMs?: number
    quietMs?: number
    lines?: number
    signal?: AbortSignal
    client?: string
    caller?: string
}

export interface NotifyInboxInput {
    kind?: unknown
    text?: unknown
    url?: unknown
    /** The session asking. Falls back to `caller` (X-Caller-Session). */
    sessionId?: string
    client: string
    caller?: string
}

/** An inbox request as the API returns it: the stored record plus where it leads. */
export interface ApiInboxRequest extends Omit<InboxRequest, 'at' | 'createdAt' | 'readAt'> {
    sessionName: string
    workspaceName: string
    read: boolean
    /** ISO times. `at` moves forward when the same unread request is sent again. */
    at: string
    createdAt: string
    readAt: string | null
}

export interface ApiChecklistItem {
    id: string
    /** Position in the checklist, from 1 — what checklist_check accepts as item. */
    n: number
    text: string
    done: boolean
    doneAt: string | null
}

/** A checklist as the API returns it: progress counted, the project and maker named, times in ISO. */
export interface ApiChecklist {
    id: string
    title: string
    workspaceId: string | null
    workspaceName: string | null
    due: string | null
    /** The deadline has passed (local date of this Mac) and items are still unchecked. */
    overdue: boolean
    done: number
    total: number
    /** Every item is checked (an empty checklist is not). */
    complete: boolean
    items: ApiChecklistItem[]
    client: string
    createdBy: string | null
    createdByName: string | null
    createdAt: string
    updatedAt: string
}

export interface CreateChecklistInput {
    title?: unknown
    due?: unknown
    /** Workspace id, name or absolute path. */
    project?: unknown
    items?: unknown
    client: string
    caller?: string
}

/** Today's local calendar date, YYYY-MM-DD — what a checklist's `due` is compared with. */
export function localDateKey(date = new Date()): string {
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface ControlApiDeps {
    // electron-store has no usable generic type in this codebase (see index.ts)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: any
    terminals: TerminalManager
    mirror: TerminalMirror
    broadcast: (channel: string, payload: unknown) => void
    hookStatus: (terminalId: string) => AgentStatusUpdate | null
    /** Persistent "related sessions" — which session opened or first worked in which. */
    relations: SessionRelations
    /** Folders of sessions in the sidebar's All sessions view. */
    sessionFolders: SessionFolders
    /** Requests sessions send for the user's hands (sign in, review, answer). */
    inbox: InboxStore
    /** Header checklists — not tied to any session. */
    checklists: ChecklistStore
    /** A session is gone for good (closed or deleted): drop what was kept for it elsewhere. */
    onSessionForgotten?: (sessionId: string) => void
}

export const CONTROL_API_SESSION_CHANNEL = 'control-api-session'
export const CONTROL_API_MASTERS_CHANNEL = 'control-api-masters'

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
    /** When each session last received a lone Escape from the API. */
    private readonly lastEscapeAt = new Map<string, number>()

    /**
     * Orchestrators and who opened what. Memory only on purpose: after a
     * restart the agents that made these calls are gone, and a red row
     * restored from disk would point at nothing.
     */
    private readonly masters = new Map<string, Omit<OrchestratorInfo, 'openedCount'>>()
    private readonly openedBy = new Map<string, string>()
    private sweepTimer: NodeJS.Timeout | null = null

    constructor(private readonly deps: ControlApiDeps) {
        // The orchestrator's shell exited: whatever drove it is gone.
        deps.terminals.events.on('exited', (id: string) => this.dropOrchestrator(id))
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    listWorkspaces(query?: string): ApiWorkspace[] {
        const needle = query?.trim().toLowerCase()
        const folders = this.folders()
        return this.workspaces()
            .filter((w) => !needle || w.name.toLowerCase().includes(needle) || w.path.toLowerCase().includes(needle))
            .map((w) => this.describeWorkspace(w, folders))
    }

    listTemplates(): ApiTemplate[] {
        const templates = (this.deps.store.get('customTemplates') as TerminalTemplate[] | undefined) ?? []
        return templates.map((t) => ({ id: t.id, name: t.name, command: t.command, description: t.description ?? '' }))
    }

    listSessions(input: ListSessionsInput = {}): ApiSession[] {
        const needle = input.query?.trim().toLowerCase()
        return this.workspaces()
            .flatMap((workspace) => workspace.sessions.map((session) => ({ workspace, session })))
            .filter(({ session }) => input.scope === 'all' || session.aiControl)
            .filter(({ workspace, session }) =>
                !needle ||
                session.name.toLowerCase().includes(needle) ||
                workspace.name.toLowerCase().includes(needle) ||
                (session.cwd ?? '').toLowerCase().includes(needle)
            )
            .map(({ workspace, session }) => this.describe(workspace, session))
    }

    /** Looking a session up does not mark it; only working in it does. */
    getSession(sessionId: string): ApiSession {
        const { workspace, session } = this.requireSession(sessionId)
        return this.describe(workspace, session)
    }

    async readOutput(
        sessionId: string,
        options: { lines?: number; mode?: 'screen' | 'tail'; client?: string; caller?: string } = {}
    ): Promise<ApiOutput> {
        const { workspace, session } = this.connect(sessionId, options.client, options.caller)
        await this.deps.mirror.flush(sessionId)
        const mode = options.mode ?? 'screen'
        const lines = clampLines(options.lines)
        const size = this.deps.mirror.size(sessionId)
        const screen = mode === 'tail'
            ? this.deps.mirror.tail(sessionId, lines)
            : this.deps.mirror.screen(sessionId).slice(-lines)
        const box = this.deps.mirror.inputBox(sessionId)
        return {
            session: this.describe(workspace, session),
            mode,
            cols: size?.cols ?? null,
            rows: size?.rows ?? null,
            lines: screen,
            suggestion: box && !box.typed && box.suggestion ? box.suggestion : null
        }
    }

    // ------------------------------------------------------------------
    // Session lifecycle
    // ------------------------------------------------------------------

    async openSession(input: OpenSessionInput): Promise<OpenSessionResult> {
        const command = this.resolveCommand(input.template, input.command)
        const { workspace, created } = this.resolveWorkspace(input.workspaceId, input.path)
        const notes: string[] = []

        let newFolder: WorkspaceFolder | undefined
        if (created) {
            workspace.aiRegistration = {
                client: input.client,
                since: Date.now(),
                ...(input.ephemeral ? { ephemeral: true } : {})
            }
            const placement = this.resolveFolder(input.folder)
            if (placement) {
                workspace.folderId = placement.folder.id
                if (placement.created) newFolder = placement.folder
            }
        } else if (input.folder !== undefined || input.ephemeral) {
            // Moving or re-flagging a workspace the user may have arranged is not
            // the API's call; it only places what it registers itself.
            notes.push('The folder was already registered, so folder and ephemeral were ignored.')
        }

        let sessionFolder: SessionFolder | undefined
        let madeSessionFolder = false
        if (input.sessionFolder !== undefined && input.sessionFolder.trim()) {
            const found = this.deps.sessionFolders.resolve(input.sessionFolder)
            if (found === 'ambiguous') throw this.ambiguousFolder(input.sessionFolder)
            if (found) sessionFolder = found
            else {
                const made = this.deps.sessionFolders.createOrGet(input.sessionFolder)
                if (made) {
                    sessionFolder = made.folder
                    madeSessionFolder = made.created
                }
            }
        }

        const templateName = input.template ? this.findTemplate(input.template)?.name : undefined
        const session: TerminalSession = {
            id: uuidv4(),
            name: (input.name?.trim() || templateName || 'AI Terminal').slice(0, MAX_NAME_LENGTH),
            cwd: workspace.path,
            type: 'regular',
            ...(command ? { initialCommand: command } : {}),
            aiControl: { client: input.client, since: Date.now() },
            ...(sessionFolder ? { sessionFolderId: sessionFolder.id } : {})
        }
        if (madeSessionFolder) this.deps.broadcast(SESSION_FOLDERS_CHANNEL, this.deps.sessionFolders.list())
        const caller = input.caller && this.hasSession(input.caller) ? input.caller : undefined

        // Mirror first so the very first bytes the shell prints are captured.
        this.deps.mirror.attach(session.id)

        const workspaces = this.workspaces()
        if (created) {
            workspaces.push({ ...workspace, sessions: [session] })
        } else {
            const target = workspaces.find((w) => w.id === workspace.id)!
            target.sessions = [...(target.sessions ?? []), session]
        }
        // Folder before workspace: the renderer files the workspace under its folder on arrival.
        if (newFolder) this.deps.store.set('folders', [...this.folders(), newFolder])
        this.deps.store.set('workspaces', workspaces)

        this.emit({
            type: 'opened',
            workspaceId: workspace.id,
            sessionId: session.id,
            session,
            ...(created ? { workspace: { ...workspace, sessions: [session] } } : {}),
            ...(newFolder ? { folder: newFolder } : {}),
            focus: input.focus === true
        })
        if (caller) {
            this.recordOpened(caller, session.id, input.client)
            this.deps.relations.recordOpened(caller, session.id)
        }

        const terminalStarted = await this.waitForPty(session.id, PTY_START_TIMEOUT_MS)
        const result: OpenSessionResult = {
            session: this.getSession(session.id),
            workspace: this.getWorkspace(workspace.id),
            createdWorkspace: created,
            createdFolder: newFolder !== undefined,
            terminalStarted,
            promptSent: false,
            ...(notes.length ? { note: notes.join(' ') } : {})
        }
        const addNote = (note: string): void => {
            result.note = result.note ? `${result.note} ${note}` : note
        }

        if (!terminalStarted) {
            addNote('The session was added but CLI Manager did not start its terminal yet. Is the main window open?')
            return result
        }

        if (input.prompt?.trim()) {
            const ready = await this.waitForStartup(session.id, command !== undefined)
            if (!ready) {
                addNote(
                    'The program did not finish starting within a minute, so the prompt was not sent. ' +
                    'Read the screen, then send the prompt with send_input.'
                )
            } else if (this.deps.mirror.showsAwaitingInput(session.id)) {
                addNote(
                    'The program is asking a question (for example whether to trust this folder), so the prompt was not sent. ' +
                    'Read the screen, answer it with send_input keys (e.g. ["down","enter"]), then send the prompt.'
                )
            } else {
                const submitted = await this.typeAndSubmit(session.id, { text: input.prompt, submit: true })
                result.promptSent = submitted
                if (!submitted) {
                    addNote(
                        'The prompt was typed but is still in the input box after pressing Enter three times. ' +
                        'Read the screen and press enter with send_input keys.'
                    )
                }
            }
            result.session = this.getSession(session.id)
        }

        return result
    }

    async sendInput(sessionId: string, input: SendInputInput): Promise<ApiSession> {
        this.connect(sessionId, input.client, input.caller)
        await this.typeAndSubmit(sessionId, input)
        const { workspace, session } = this.requireSession(sessionId)
        return this.describe(workspace, session)
    }

    /** Returns false only when the text is provably still sitting unsubmitted in the input box. */
    private async typeAndSubmit(sessionId: string, input: SendInputInput): Promise<boolean> {
        this.requireSession(sessionId)
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

        let submitted = true
        if (input.text !== undefined) {
            const submit = input.submit !== false
            const text = submit ? input.text.replace(/[\r\n]+$/, '') : input.text
            if (text.length > 0) {
                await this.settleAfterEscape(sessionId)
                this.write(sessionId, this.encodeText(sessionId, text))
            }
            if (submit) {
                await sleep(submitDelay(text.length))
                this.write(sessionId, '\r')
                if (text.length > 0) submitted = await this.confirmSubmitted(sessionId, text)
            }
        }

        for (const key of keys) {
            await sleep(KEY_GAP_MS)
            // Escape followed by any key would read as Alt+key, not two presses.
            // Escape twice stays fast: Claude Code reads a double Escape as its own gesture.
            if (key !== ESCAPE) await this.settleAfterEscape(sessionId)
            this.write(sessionId, key)
        }

        return submitted
    }

    private write(sessionId: string, data: string): void {
        this.deps.terminals.writeInput(sessionId, data)
        if (data === ESCAPE) this.lastEscapeAt.set(sessionId, Date.now())
    }

    private async settleAfterEscape(sessionId: string): Promise<void> {
        const since = Date.now() - (this.lastEscapeAt.get(sessionId) ?? 0)
        if (since < ESCAPE_SETTLE_MS) await sleep(ESCAPE_SETTLE_MS - since)
    }

    /**
     * After Enter, the prompt should leave the input box. Only checked when the
     * program draws one and the prompt was visible in it; anything else (a
     * shell, a multi-line paste shown as a placeholder) is taken as submitted.
     */
    private async confirmSubmitted(sessionId: string, text: string): Promise<boolean> {
        const head = text.replace(/\s+/g, ' ').trim().slice(0, SUBMIT_HEAD_CHARS)
        if (!head) return true
        const stillInBox = async (): Promise<boolean> => {
            await this.deps.mirror.flush(sessionId)
            const box = this.deps.mirror.inputBox(sessionId)
            return box !== null && box.typed.includes(head)
        }

        for (let attempt = 0; attempt <= SUBMIT_RETRIES; attempt++) {
            const deadline = Date.now() + SUBMIT_CONFIRM_MS
            while (Date.now() < deadline) {
                if (!(await stillInBox())) return true
                await sleep(SUBMIT_CONFIRM_POLL_MS)
            }
            if (attempt === SUBMIT_RETRIES) break
            console.warn(`[control-api] prompt still in the input box of ${sessionId}; pressing Enter again`)
            this.write(sessionId, '\r')
        }
        return !(await stillInBox())
    }

    /**
     * Waits until the session settles: no output for `quietMs`, no
     * "esc to interrupt" on screen, and no hook saying a turn is running.
     * Returns the screen either way, flagged `timedOut` when it never settled.
     */
    async waitForIdle(sessionId: string, input: WaitInput = {}): Promise<ApiWaitResult> {
        this.connect(sessionId, input.client, input.caller)
        const timeoutMs = Math.min(Math.max(input.timeoutMs ?? 120_000, 0), MAX_WAIT_MS)
        const quietMs = Math.max(input.quietMs ?? DEFAULT_QUIET_MS, 200)
        const started = Date.now()
        let sleptMs = 0
        const elapsed = (): number => Date.now() - started - sleptMs

        let timedOut = false
        for (;;) {
            await this.deps.mirror.flush(sessionId)
            const state = this.stateOf(sessionId, quietMs)
            // At least one quiet window after the call starts, so a wait issued
            // right after send_input cannot return before the agent reacted.
            const settled = (state === 'idle' && elapsed() >= quietMs) || state === 'exited'
            if (settled) break
            if (input.signal?.aborted) break
            if (elapsed() >= timeoutMs) {
                timedOut = true
                break
            }
            const before = Date.now()
            await sleep(WAIT_POLL_MS)
            const gap = Date.now() - before - WAIT_POLL_MS
            if (gap >= SLEEP_GAP_MS) sleptMs += gap
            // The user may close the session, or take it back, while we wait.
            // Stopping here is what makes "Disconnect AI" interrupt the AI.
            if (!this.requireSession(sessionId).session.aiControl) {
                throw new ControlApiError(
                    409,
                    'disconnected',
                    'The user disconnected this session while you were waiting. Stop working in it unless the user asks you to continue.'
                )
            }
        }

        const output = await this.readOutput(sessionId, { lines: input.lines, mode: 'screen', client: input.client, caller: input.caller })
        return { ...output, timedOut, waitedMs: Date.now() - started, sleptMs }
    }

    focusSession(sessionId: string, client?: string, caller?: string): ApiSession {
        const { workspace, session } = this.connect(sessionId, client, caller)
        this.emit({ type: 'focus', workspaceId: workspace.id, sessionId })
        return this.describe(workspace, session)
    }

    /**
     * Renames a session in the sidebar. A label change, not work inside the
     * terminal, so it does not mark the session as AI-driven.
     */
    renameSession(sessionId: string, name: string): ApiSession {
        const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
        if (!trimmed) throw new ControlApiError(400, 'bad_request', 'name must not be empty.')

        const workspaces = this.workspaces()
        for (const workspace of workspaces) {
            const session = workspace.sessions.find((s) => s.id === sessionId)
            if (!session) continue
            session.name = trimmed
            this.deps.store.set('workspaces', workspaces)
            this.emit({ type: 'updated', workspaceId: workspace.id, sessionId, session: { ...session } })
            return this.describe(workspace, session)
        }
        throw new ControlApiError(404, 'not_found', `No session with id ${sessionId}. It may have been closed.`)
    }

    /** Hands the session to the user: it keeps running and loses its AI mark. */
    releaseSession(sessionId: string): void {
        this.requireSession(sessionId)
        this.clearAiControl(sessionId)
    }

    /** Works on any session, including ones the user opened. */
    closeSession(sessionId: string, handTo?: string): { handedOver: number } {
        const { workspace } = this.requireSession(sessionId)
        // Check the heir before anything is killed: a refused call must leave the session running.
        if (handTo !== undefined) {
            if (handTo === sessionId) throw new ControlApiError(400, 'bad_request', 'handTo must be a different session.')
            this.requireSession(handTo)
        }
        const handedOver = handTo !== undefined ? this.deps.relations.inherit(sessionId, handTo) : 0
        this.deps.terminals.killTerminal(sessionId)
        this.deps.mirror.detach(sessionId)
        this.deps.onSessionForgotten?.(sessionId)
        this.lastEscapeAt.delete(sessionId)
        this.forgetOrchestration(sessionId)
        this.deps.relations.forget(sessionId)

        const workspaces = this.workspaces()
        const target = workspaces.find((w) => w.id === workspace.id)
        if (target) target.sessions = target.sessions.filter((s) => s.id !== sessionId)
        this.deps.store.set('workspaces', workspaces)

        this.emit({ type: 'closed', workspaceId: workspace.id, sessionId })
        this.removeIfSpentEphemeral(workspace.id)
        return { handedOver }
    }

    // ------------------------------------------------------------------
    // Session folders and relations
    // ------------------------------------------------------------------

    listSessionFolders(): ApiSessionFolder[] {
        const workspaces = this.workspaces()
        return this.deps.sessionFolders.list().map((f) => ({
            id: f.id,
            name: f.name,
            createdAt: new Date(f.createdAt).toISOString(),
            sessions: workspaces.flatMap((w) =>
                (w.sessions ?? []).filter((s) => s.sessionFolderId === f.id).map((s) => ({ id: s.id, name: s.name, workspaceName: w.name }))
            )
        }))
    }

    /** The same name twice gives back the folder that exists, so an agent repeating the call adds none. */
    createSessionFolder(name: string): { folder: ApiSessionFolder; created: boolean } {
        const made = this.deps.sessionFolders.createOrGet(name.slice(0, MAX_NAME_LENGTH))
        if (!made) throw new ControlApiError(400, 'bad_request', 'name must not be empty.')
        if (made.created) this.broadcastFolders()
        return { folder: this.describeFolder(made.folder.id), created: made.created }
    }

    renameSessionFolder(ref: string, name: string): ApiSessionFolder {
        const folder = this.requireSessionFolder(ref)
        const trimmed = name.trim().slice(0, MAX_NAME_LENGTH)
        if (!trimmed) throw new ControlApiError(400, 'bad_request', 'name must not be empty.')
        if (this.deps.sessionFolders.findByName(trimmed).some((f) => f.id !== folder.id)) {
            throw new ControlApiError(409, 'name_taken', `Another session folder is already named "${trimmed}".`)
        }
        this.deps.sessionFolders.rename(folder.id, trimmed)
        this.broadcastFolders()
        return this.describeFolder(folder.id)
    }

    /** Removes the folder only; its sessions stay open and go back to "No folder". */
    deleteSessionFolder(ref: string): { removed: true; releasedSessions: number } {
        const folder = this.requireSessionFolder(ref)
        const members = this.deps.sessionFolders.sessionIdsIn(folder.id)
        this.deps.sessionFolders.remove(folder.id)
        this.broadcastFolders()
        for (const id of members) this.emitUpdated(id)
        return { removed: true, releasedSessions: members.length }
    }

    /** `null` takes the session out of its folder. A label change, so no AI mark and no relation. */
    moveSessionToFolder(sessionId: string, ref: string | null): ApiSession {
        const { workspace, session } = this.requireSession(sessionId)
        const folder = ref === null ? null : this.requireSessionFolder(ref)
        this.deps.sessionFolders.moveSession(sessionId, folder ? folder.id : null)
        this.emitUpdated(sessionId)
        return this.describe(workspace, this.requireSession(sessionId).session)
    }

    /** Pairs shown in the session's Related dialog; the ones the user removed are left out. */
    sessionRelations(sessionId: string): { sessionId: string; relations: ApiRelation[] } {
        this.requireSession(sessionId)
        const relations: ApiRelation[] = []
        for (const r of this.deps.relations.list()) {
            if (r.from !== sessionId && r.to !== sessionId) continue
            const outgoing = r.from === sessionId
            const otherId = outgoing ? r.to : r.from
            const other = this.findSession(otherId)
            if (!other) continue
            relations.push({
                sessionId: otherId,
                name: other.session.name,
                workspaceName: other.workspace.name,
                kind: r.kind,
                direction: outgoing ? 'outgoing' : 'incoming',
                at: new Date(r.at).toISOString()
            })
        }
        return { sessionId, relations }
    }

    /**
     * Unregisters a workspace the API registered. The folder on disk is never
     * touched — this only takes it off the sidebar. Refused for anything the
     * user added, and while sessions or worktrees still hang off it.
     */
    unregisterWorkspace(workspaceId: string): void {
        const workspace = this.workspaces().find((w) => w.id === workspaceId)
        if (!workspace) throw new ControlApiError(404, 'workspace_not_found', `No workspace with id ${workspaceId}.`)
        if (!workspace.aiRegistration || workspace.isHome || workspace.isPlayground) {
            throw new ControlApiError(
                403,
                'not_ai_registered',
                'The user added this workspace; only workspaces the API registered can be unregistered. Ask the user to remove it.'
            )
        }
        if (workspace.sessions.length > 0) {
            throw new ControlApiError(
                409,
                'has_sessions',
                `The workspace still has ${workspace.sessions.length} open session(s). Close them first.`
            )
        }
        if (this.workspaces().some((w) => w.parentWorkspaceId === workspaceId)) {
            throw new ControlApiError(409, 'has_worktrees', 'Worktree workspaces are registered under this one. Remove them first.')
        }
        this.removeWorkspace(workspaceId)
    }

    // ------------------------------------------------------------------
    // Inbox — a session asks for the user's hands
    // ------------------------------------------------------------------

    /**
     * Puts a request in the app's inbox. The session is the one named in the
     * body, else the caller's own (X-Caller-Session) — a request has to lead
     * somewhere, so one without an open session is refused. Sending does not
     * mark the session as AI-driven: the sender is the session itself.
     */
    notifyInbox(input: NotifyInboxInput): { request: ApiInboxRequest; created: boolean } {
        const check = checkInboxInput(input)
        if (!check.ok) throw new ControlApiError(400, 'bad_request', check.message)
        const sessionId = input.sessionId?.trim() || input.caller
        if (!sessionId) {
            throw new ControlApiError(
                400,
                'session_required',
                'Say which session is asking: pass sessionId, or send X-Caller-Session (the CLIMANAGER_SESSION_ID of the terminal you run in).'
            )
        }
        this.requireSession(sessionId)
        const { request, created } = this.deps.inbox.add({
            sessionId,
            kind: check.kind,
            text: check.text,
            ...(check.url ? { url: check.url } : {}),
            client: input.client
        })
        return { request: this.describeInbox(request), created }
    }

    listInbox(options: { unreadOnly?: boolean } = {}): { unreadCount: number; requests: ApiInboxRequest[] } {
        return {
            unreadCount: this.deps.inbox.unreadCount(),
            requests: this.deps.inbox.list(options).map((r) => this.describeInbox(r))
        }
    }

    /** The sender resolved it itself (the login finished, the question was answered elsewhere). */
    readInbox(requestId: string): ApiInboxRequest {
        const request = this.deps.inbox.markRead(requestId)
        if (!request) throw new ControlApiError(404, 'not_found', `No inbox request with id ${requestId}.`)
        return this.describeInbox(request)
    }

    private describeInbox(request: InboxRequest): ApiInboxRequest {
        const { at, createdAt, readAt, ...rest } = request
        const found = this.workspaces()
            .flatMap((workspace) => workspace.sessions.map((session) => ({ workspace, session })))
            .find(({ session }) => session.id === request.sessionId)
        return {
            ...rest,
            sessionName: found?.session.name ?? '',
            workspaceName: found?.workspace.name ?? '',
            read: Boolean(readAt),
            at: new Date(at).toISOString(),
            createdAt: new Date(createdAt).toISOString(),
            readAt: readAt ? new Date(readAt).toISOString() : null
        }
    }

    // ------------------------------------------------------------------
    // Checklists — header lists that belong to no session
    // ------------------------------------------------------------------

    /**
     * Open checklists by default, in the header's order (nearest deadline first).
     * Reading or editing a checklist never marks a session as AI-driven: it is not a terminal.
     */
    listChecklists(options: { status?: ChecklistStatus; project?: string } = {}): { checklists: ApiChecklist[] } {
        const workspaceId = options.project ? this.requireProject(options.project).id : undefined
        const names = this.nameIndex()
        return {
            checklists: this.deps.checklists
                .list({ status: options.status ?? 'open', workspaceId })
                .map((c) => this.describeChecklist(c, names))
        }
    }

    getChecklist(ref: string): ApiChecklist {
        return this.describeChecklist(this.requireChecklist(ref))
    }

    /**
     * Makes a checklist, items included. An open checklist with the same title is reused
     * (created: false) — the items it lacks are added — so a repeated call does not stack copies.
     */
    createChecklist(input: CreateChecklistInput): { checklist: ApiChecklist; created: boolean } {
        const check = checkChecklistInput(input, { requireTitle: true })
        if (!check.ok) throw new ControlApiError(400, 'bad_request', check.message)
        const items = input.items === undefined ? { ok: true as const, texts: [] } : checkItemTexts(input.items)
        if (!items.ok) throw new ControlApiError(400, 'bad_request', items.message)
        const workspaceId = this.projectOf(input.project)
        const result = this.deps.checklists.create({
            title: check.title!,
            ...(check.due ? { due: check.due } : {}),
            ...(workspaceId ? { workspaceId } : {}),
            items: items.texts,
            client: input.client,
            ...(input.caller && this.hasSession(input.caller) ? { createdBy: input.caller } : {})
        })
        if (!result) throw this.tooMany()
        return { checklist: this.describeChecklist(result.checklist), created: result.created }
    }

    /** Title, due (null clears) and project (null clears). */
    updateChecklist(ref: string, input: { title?: unknown; due?: unknown; project?: unknown }): ApiChecklist {
        const check = checkChecklistInput(input, { requireTitle: false })
        if (!check.ok) throw new ControlApiError(400, 'bad_request', check.message)
        const { ok: _ok, ...patch } = check
        const project = input.project === undefined ? undefined : input.project === null || input.project === '' ? null : this.projectOf(input.project)
        if (Object.keys(patch).length === 0 && project === undefined) {
            throw new ControlApiError(400, 'bad_request', 'Send at least one of title, due, project.')
        }
        const target = this.requireChecklist(ref)
        const updated = this.deps.checklists.update(target.id, { ...patch, ...(project !== undefined ? { workspaceId: project } : {}) })
        return this.describeChecklist(updated ?? target)
    }

    removeChecklist(ref: string): void {
        this.deps.checklists.remove(this.requireChecklist(ref).id)
    }

    /** Adds items at the end; text the checklist already has is skipped. */
    addChecklistItems(ref: string, itemsInput: unknown): { checklist: ApiChecklist; added: number } {
        const items = checkItemTexts(itemsInput)
        if (!items.ok) throw new ControlApiError(400, 'bad_request', items.message)
        if (items.texts.length === 0) throw new ControlApiError(400, 'bad_request', 'items is empty')
        const target = this.requireChecklist(ref)
        const result = this.deps.checklists.addItems(target.id, items.texts)
        if (!result) throw this.tooMany()
        return { checklist: this.describeChecklist(result.checklist), added: result.added }
    }

    /** Checks or unchecks an item (done), or renames it (text). item is its number from 1, or its id. */
    updateChecklistItem(ref: string, itemRef: unknown, input: { text?: unknown; done?: unknown }): ApiChecklist {
        const target = this.requireChecklist(ref)
        const itemId = this.requireItem(target, itemRef)
        const patch: { text?: string; done?: boolean } = {}
        if (input.text !== undefined) {
            if (typeof input.text !== 'string' || !cleanText(input.text)) throw new ControlApiError(400, 'bad_request', 'text must be a non-empty string')
            patch.text = cleanText(input.text)
        }
        if (input.done !== undefined) {
            if (typeof input.done !== 'boolean') throw new ControlApiError(400, 'bad_request', 'done must be true or false')
            patch.done = input.done
        }
        if (Object.keys(patch).length === 0) throw new ControlApiError(400, 'bad_request', 'Send text or done.')
        return this.describeChecklist(this.deps.checklists.updateItem(target.id, itemId, patch) ?? target)
    }

    removeChecklistItem(ref: string, itemRef: unknown): ApiChecklist {
        const target = this.requireChecklist(ref)
        const itemId = this.requireItem(target, itemRef)
        return this.describeChecklist(this.deps.checklists.removeItem(target.id, itemId) ?? target)
    }

    private requireChecklist(ref: string): Checklist {
        const found = this.deps.checklists.resolve(ref)
        if (found === 'ambiguous') {
            throw new ControlApiError(409, 'ambiguous_checklist', `More than one checklist is titled "${ref}". Use its id (checklist_list).`)
        }
        if (!found) throw new ControlApiError(404, 'checklist_not_found', `No checklist "${ref}".`)
        return found
    }

    /** An item by its number from 1 (a number or a numeric string), else by id. */
    private requireItem(checklist: Checklist, ref: unknown): string {
        if (ref === undefined || ref === null || ref === '') throw new ControlApiError(400, 'bad_request', 'item is required (its number from 1, or its id)')
        const asNumber = typeof ref === 'number' ? ref : typeof ref === 'string' && /^\d+$/.test(ref.trim()) ? Number(ref.trim()) : null
        const item =
            asNumber !== null
                ? checklist.items[asNumber - 1]
                : typeof ref === 'string'
                  ? checklist.items.find((i) => i.id === ref)
                  : undefined
        if (!item) {
            throw new ControlApiError(404, 'item_not_found', `No item ${String(ref)} in "${checklist.title}" (it has ${checklist.items.length}).`)
        }
        return item.id
    }

    /** A project given as workspace id, name (case ignored) or absolute path; undefined when none was given. */
    private projectOf(value: unknown): string | undefined {
        if (value === undefined || value === null || value === '') return undefined
        if (typeof value !== 'string') throw new ControlApiError(400, 'bad_request', 'project must be a workspace id, name or path')
        return this.requireProject(value).id
    }

    private requireProject(ref: string): Workspace {
        const workspaces = this.workspaces()
        const byId = workspaces.find((w) => w.id === ref)
        if (byId) return byId
        if (path.isAbsolute(ref)) {
            const target = existsSync(ref) ? canonicalPath(ref) : path.resolve(ref)
            const byPath = workspaces.find((w) => (existsSync(w.path) ? canonicalPath(w.path) : path.resolve(w.path)) === target)
            if (byPath) return byPath
        }
        const needle = ref.trim().toLowerCase()
        const byName = workspaces.filter((w) => w.name.trim().toLowerCase() === needle)
        if (byName.length > 1) {
            throw new ControlApiError(409, 'ambiguous_project', `More than one workspace is named "${ref}". Use its id or path (list_workspaces).`)
        }
        if (!byName[0]) throw new ControlApiError(404, 'workspace_not_found', `No workspace "${ref}" (id, name or path).`)
        return byName[0]
    }

    private tooMany(): ControlApiError {
        return new ControlApiError(409, 'too_many', 'Too many checklists or items. Remove finished checklists first.')
    }

    /** Workspace and session names by id, for naming a checklist's project and maker. */
    private nameIndex(): { workspaces: Map<string, string>; sessions: Map<string, string> } {
        const workspaces = new Map<string, string>()
        const sessions = new Map<string, string>()
        for (const workspace of this.workspaces()) {
            workspaces.set(workspace.id, workspace.name)
            for (const session of workspace.sessions) sessions.set(session.id, session.name)
        }
        return { workspaces, sessions }
    }

    private describeChecklist(checklist: Checklist, names = this.nameIndex()): ApiChecklist {
        const done = checklist.items.filter((i) => i.doneAt !== undefined).length
        const complete = isComplete(checklist)
        const workspaceName = checklist.workspaceId ? names.workspaces.get(checklist.workspaceId) ?? null : null
        return {
            id: checklist.id,
            title: checklist.title,
            workspaceId: workspaceName !== null ? checklist.workspaceId! : null,
            workspaceName,
            due: checklist.due ?? null,
            overdue: !complete && checklist.due !== undefined && checklist.due < localDateKey(),
            done,
            total: checklist.items.length,
            complete,
            items: checklist.items.map((item, index) => ({
                id: item.id,
                n: index + 1,
                text: item.text,
                done: item.doneAt !== undefined,
                doneAt: item.doneAt !== undefined ? new Date(item.doneAt).toISOString() : null
            })),
            client: checklist.client,
            createdBy: checklist.createdBy ?? null,
            createdByName: checklist.createdBy ? names.sessions.get(checklist.createdBy) ?? null : null,
            createdAt: new Date(checklist.createdAt).toISOString(),
            updatedAt: new Date(checklist.updatedAt).toISOString()
        }
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
            // The mirror stays: the API can still read this session later, and a
            // mirror attached then would have missed everything printed until then.
            this.emit({ type: 'updated', workspaceId: workspace.id, sessionId, session: { ...session } })
            return true
        }
        return false
    }

    /** The user deleted a session or workspace; drop what we held for it. */
    forgetSession(sessionId: string): void {
        this.deps.mirror.detach(sessionId)
        this.deps.onSessionForgotten?.(sessionId)
        this.lastEscapeAt.delete(sessionId)
        this.forgetOrchestration(sessionId)
        this.deps.relations.forget(sessionId)
    }

    /**
     * State and last line of each session, for the Related sessions dialog.
     * Read only: unlike the API's reads it does not mark anything as AI-driven.
     * Unknown ids are skipped.
     */
    async peekSessions(sessionIds: string[]): Promise<SessionPeek[]> {
        const peeks: SessionPeek[] = []
        for (const sessionId of sessionIds) {
            if (!this.hasSession(sessionId)) continue
            await this.deps.mirror.flush(sessionId)
            const hook = this.deps.hookStatus(sessionId)
            const summary = this.deps.mirror.summary(sessionId)
            peeks.push({
                sessionId,
                state: this.stateOf(sessionId, DEFAULT_QUIET_MS),
                awaitingInput: this.deps.mirror.showsAwaitingInput(sessionId) || hook?.awaitingInput === true,
                lastLine: summary.text,
                lastLineIsRecap: summary.isRecap
            })
        }
        return peeks
    }

    // ------------------------------------------------------------------
    // Orchestrators (display only — see OrchestratorInfo)
    // ------------------------------------------------------------------

    /** Every API call carrying X-Caller-Session. Unknown ids are ignored. */
    noteCaller(callerId: string): void {
        const master = this.masters.get(callerId)
        if (master) master.lastSeen = Date.now()
    }

    mastersSnapshot(): ControlApiMasters {
        const masters: Record<string, OrchestratorInfo> = {}
        for (const [id, info] of this.masters) masters[id] = { ...info, openedCount: this.openedCount(id) }
        return { masters, openedBy: Object.fromEntries(this.openedBy) }
    }

    /** The API was switched off: nothing can be orchestrating through it any more. */
    clearOrchestrators(): void {
        if (this.masters.size === 0 && this.openedBy.size === 0) return
        this.masters.clear()
        this.openedBy.clear()
        this.stopSweep()
        this.emitMasters()
    }

    private recordOpened(callerId: string, openedId: string, client: string): void {
        if (callerId === openedId) return
        const now = Date.now()
        const master = this.masters.get(callerId)
        if (master) master.lastSeen = now
        else this.masters.set(callerId, { since: now, lastSeen: now, client })
        this.openedBy.set(openedId, callerId)
        this.startSweep()
        this.emitMasters()
    }

    private dropOrchestrator(sessionId: string): void {
        if (!this.masters.delete(sessionId)) return
        if (this.masters.size === 0) this.stopSweep()
        this.emitMasters()
    }

    /** A session went away, as an orchestrator, as one it opened, or both. */
    private forgetOrchestration(sessionId: string): void {
        const wasMaster = this.masters.delete(sessionId)
        const wasOpened = this.openedBy.delete(sessionId)
        if (!wasMaster && !wasOpened) return
        if (this.masters.size === 0) this.stopSweep()
        this.emitMasters()
    }

    private openedCount(masterId: string): number {
        let count = 0
        for (const owner of this.openedBy.values()) if (owner === masterId) count++
        return count
    }

    private startSweep(): void {
        if (this.sweepTimer) return
        this.sweepTimer = setInterval(() => this.sweepIdleOrchestrators(), ORCHESTRATOR_SWEEP_MS)
        this.sweepTimer.unref?.()
    }

    private stopSweep(): void {
        if (this.sweepTimer) clearInterval(this.sweepTimer)
        this.sweepTimer = null
    }

    private sweepIdleOrchestrators(): void {
        const cutoff = Date.now() - ORCHESTRATOR_IDLE_MS
        let changed = false
        for (const [id, info] of this.masters) {
            if (info.lastSeen >= cutoff) continue
            this.masters.delete(id)
            changed = true
        }
        if (this.masters.size === 0) this.stopSweep()
        if (changed) this.emitMasters()
    }

    private emitMasters(): void {
        this.deps.broadcast(CONTROL_API_MASTERS_CHANNEL, this.mastersSnapshot())
    }

    /**
     * A session was removed from this workspace (by the user or the API). An
     * ephemeral workspace goes with its last session. Returns true when it did.
     */
    removeIfSpentEphemeral(workspaceId: string): boolean {
        const workspace = this.workspaces().find((w) => w.id === workspaceId)
        if (!workspace?.aiRegistration?.ephemeral || workspace.sessions.length > 0) return false
        if (this.workspaces().some((w) => w.parentWorkspaceId === workspaceId)) return false
        this.removeWorkspace(workspaceId)
        return true
    }

    /**
     * Startup sweep: an ephemeral workspace left without sessions (the app quit
     * between the last close and the cleanup) would otherwise stay forever.
     */
    pruneSpentEphemeral(): void {
        for (const workspace of this.workspaces()) this.removeIfSpentEphemeral(workspace.id)
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    private broadcastFolders(): void {
        this.deps.broadcast(SESSION_FOLDERS_CHANNEL, this.deps.sessionFolders.list())
    }

    private ambiguousFolder(ref: string): ControlApiError {
        return new ControlApiError(409, 'ambiguous_folder', `More than one session folder is named "${ref}". Use its id (list the folders).`)
    }

    private requireSessionFolder(ref: string): SessionFolder {
        const found = this.deps.sessionFolders.resolve(ref)
        if (found === 'ambiguous') throw this.ambiguousFolder(ref)
        if (!found) throw new ControlApiError(404, 'folder_not_found', `No session folder "${ref}".`)
        return found
    }

    private describeFolder(folderId: string): ApiSessionFolder {
        return this.listSessionFolders().find((f) => f.id === folderId)!
    }

    private findSession(sessionId: string): { workspace: Workspace; session: TerminalSession } | undefined {
        for (const workspace of this.workspaces()) {
            const session = (workspace.sessions ?? []).find((s) => s.id === sessionId)
            if (session) return { workspace, session }
        }
        return undefined
    }

    /** Tells the windows the session changed (a replace, so a dropped field disappears). */
    private emitUpdated(sessionId: string): void {
        const found = this.findSession(sessionId)
        if (found) this.emit({ type: 'updated', workspaceId: found.workspace.id, sessionId, session: { ...found.session } })
    }

    private folders(): WorkspaceFolder[] {
        return (this.deps.store.get('folders') as WorkspaceFolder[] | undefined) ?? []
    }

    private removeWorkspace(workspaceId: string): void {
        this.deps.store.set('workspaces', this.workspaces().filter((w) => w.id !== workspaceId))
        this.deps.checklists.forgetWorkspace(workspaceId)
        this.emit({ type: 'workspaceRemoved', workspaceId })
    }

    private getWorkspace(workspaceId: string): ApiWorkspace {
        const workspace = this.workspaces().find((w) => w.id === workspaceId)
        if (!workspace) throw new ControlApiError(404, 'workspace_not_found', `No workspace with id ${workspaceId}.`)
        return this.describeWorkspace(workspace, this.folders())
    }

    private describeWorkspace(w: Workspace, folders: WorkspaceFolder[]): ApiWorkspace {
        const folder = w.folderId ? folders.find((f) => f.id === w.folderId) : undefined
        return {
            id: w.id,
            name: w.name,
            path: w.path,
            kind: w.isHome ? 'home' : w.isPlayground ? 'playground' : w.parentWorkspaceId ? 'worktree' : 'folder',
            ...(w.branchName ? { branchName: w.branchName } : {}),
            sessionCount: w.sessions?.length ?? 0,
            aiSessionCount: (w.sessions ?? []).filter((s) => s.aiControl).length,
            folder: folder ? { id: folder.id, name: folder.name } : null,
            registeredBy: w.aiRegistration ? 'ai' : 'user',
            registeredByClient: w.aiRegistration?.client ?? '',
            ephemeral: w.aiRegistration?.ephemeral === true
        }
    }

    /**
     * Where a newly registered workspace goes. An id or a name (case-insensitive)
     * of an existing folder wins; any other name creates that folder. '' is the
     * top level, and omitted falls back to the folder named in Settings.
     * The new folder is returned unsaved — the caller stores it with the workspace.
     */
    private resolveFolder(requested?: string): { folder: WorkspaceFolder; created: boolean } | null {
        const name = (requested ?? this.defaultFolderName()).trim().slice(0, MAX_NAME_LENGTH)
        if (!name) return null
        const folders = this.folders()
        const found =
            folders.find((f) => f.id === name) ??
            folders.find((f) => f.name.trim().toLowerCase() === name.toLowerCase())
        if (found) return { folder: found, created: false }
        return { folder: { id: uuidv4(), name, isExpanded: true, createdAt: Date.now() }, created: true }
    }

    private defaultFolderName(): string {
        const settings = this.deps.store.get('settings') as UserSettings | undefined
        return { ...DEFAULT_CONTROL_API, ...(settings?.controlApi ?? {}) }.aiFolderName ?? ''
    }

    private workspaces(): Workspace[] {
        return ((this.deps.store.get('workspaces') as Workspace[] | undefined) ?? []).map((w) => ({
            ...w,
            sessions: w.sessions ?? []
        }))
    }

    private hasSession(sessionId: string): boolean {
        return this.workspaces().some((w) => w.sessions.some((s) => s.id === sessionId))
    }

    private requireSession(sessionId: string): { workspace: Workspace; session: TerminalSession } {
        for (const workspace of this.workspaces()) {
            const session = workspace.sessions.find((s) => s.id === sessionId)
            if (session) return { workspace, session }
        }
        throw new ControlApiError(404, 'not_found', `No session with id ${sessionId}. It may have been closed.`)
    }

    /**
     * Marks a session as AI-driven the first time the API works in it, so the
     * user sees which of their terminals something else may type into. A
     * session that already carries the mark keeps its original client and time.
     * When the request said which session it came from, the two become related
     * (first contact only — see SessionRelations.recordConnected).
     */
    private connect(sessionId: string, client?: string, caller?: string): { workspace: Workspace; session: TerminalSession } {
        const workspaces = this.workspaces()
        for (const workspace of workspaces) {
            const session = workspace.sessions.find((s) => s.id === sessionId)
            if (!session) continue
            if (!session.aiControl) {
                session.aiControl = { client: client || 'api', since: Date.now() }
                this.deps.store.set('workspaces', workspaces)
                this.emit({ type: 'updated', workspaceId: workspace.id, sessionId, session: { ...session } })
            }
            // Covers a session whose terminal has not started yet.
            this.deps.mirror.attach(sessionId)
            if (caller && caller !== sessionId && this.hasSession(caller)) {
                this.deps.relations.recordConnected(caller, sessionId)
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
            aiControlled: session.aiControl !== undefined,
            controlledBy: session.aiControl?.client ?? '',
            connectedAt: session.aiControl ? new Date(session.aiControl.since).toISOString() : '',
            screenPartial: this.deps.mirror.isPartial(session.id),
            memo: session.memo ?? '',
            orchestrator: this.describeOrchestrator(session.id),
            openedBy: this.openedBy.get(session.id) ?? null,
            sessionFolder: this.sessionFolderOf(session),
            memoPages: [session.memo ?? '', ...(session.memoPages ?? [])]
        }
    }

    private sessionFolderOf(session: TerminalSession): ApiSession['sessionFolder'] {
        if (!session.sessionFolderId) return null
        const folder = this.deps.sessionFolders.list().find((f) => f.id === session.sessionFolderId)
        return folder ? { id: folder.id, name: folder.name } : null
    }

    private describeOrchestrator(sessionId: string): ApiSession['orchestrator'] {
        const info = this.masters.get(sessionId)
        if (!info) return null
        return {
            since: new Date(info.since).toISOString(),
            lastSeen: new Date(info.lastSeen).toISOString(),
            client: info.client,
            openedCount: this.openedCount(sessionId)
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
