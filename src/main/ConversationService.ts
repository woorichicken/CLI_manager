import type {
    ChatCommand,
    ChatSendOptions,
    ChatSendResult,
    DraftFromTerminalResult,
    DraftToTerminalResult,
    ConversationAgent,
    ConversationSnapshot,
    InterruptResult,
    PromptAnswer,
    PromptAnswerResult,
    PromptMenu,
    QueuedMessage
} from '../shared/conversation'
import { CHAT_TURN_LIMIT, MAX_CHAT_TEXT_LENGTH, terminalCommand } from '../shared/conversation'
// the chat's own functions (pure): a phone may open what the chat shows as a link, by the same reading
import { addLinkedText, mentionedPaths } from '../renderer/src/components/ChatView/chatMentions'
import { isBusyRow, screenAgentMode } from './screenLines'
import { answerSteps, KEYS, PromptAnswerError, readPrompt } from './promptScreen'
import type { TranscriptReader } from './TranscriptReader'

/**
 * The Chat view's main-process side: one conversation per terminal session,
 * built from the agent's transcript file (TranscriptReader) and its live screen
 * (TerminalMirror — working, a question menu).
 *
 * Watches only sessions a Chat view is open on (or that have a queued send),
 * every POLL_MS: a stat of the transcript, and a screen read when the terminal
 * printed since the last one. A change bumps the session's revision and calls
 * `onChange`; the view then fetches the snapshot. Same snapshot for every
 * caller, so a phone page can get exactly what the desktop shows.
 */

const POLL_MS = 700
/** Text sent while the agent works waits for this much quiet after the turn ends. */
const QUEUE_QUIET_MS = 1500
const MAX_TEXT_LENGTH = MAX_CHAT_TEXT_LENGTH
/** What the agent's terminal takes as "stop this turn" (Claude Code and Codex both print "esc to interrupt"). */
const INTERRUPT_KEY = '\x1b'
/** Between the keys of a card's answer, as the Control API spaces keys. */
const KEY_GAP_MS = 60
/**
 * Before a card's Enter (or its typed answer) the screen must show the option it meant highlighted.
 * The agent draws a moved highlight a little after the key: read again every CONFIRM_POLL_MS until
 * it does, for at most CONFIRM_MS — then someone else's key moved it (F04) and Enter is not sent.
 */
const CONFIRM_MS = 1500
const CONFIRM_POLL_MS = 40
/** `type` returned false: Enter was pressed (and retried) but the text is still in the agent's input box. */
const NOT_SUBMITTED: ChatSendResult = {
    status: 'rejected',
    reason: 'not_submitted',
    message: 'The message is in the terminal input line but was not submitted. Press Enter there, or clear it.'
}
/** A phone device disconnected (or the phone switched off) while its request waited (F02). */
const REVOKED = {
    status: 'rejected',
    reason: 'revoked',
    message: 'This device was disconnected from the Mac.'
} as const
const CONVERSATION_CHANGED: ChatSendResult = {
    status: 'rejected',
    reason: 'conversation_changed',
    message: 'The agent moved to another conversation (/resume or /clear), so the waiting message was dropped.'
}
const NO_AGENT: ChatSendResult = {
    status: 'rejected',
    reason: 'no_agent',
    message: 'The agent in this session is not running, so the message would go to the shell. Start it in the terminal first.'
}

/**
 * Who sends from outside this Mac: the queue `origin` (a phone's `device:<id>` / `tailscale:<login>`)
 * and whether it may still type. A phone's access is judged when its request arrives, but the
 * service waits — flushes, the program in front, the session's lane, the queue — and the device
 * can be disconnected meanwhile. `allowed` is asked again right before any key goes (ovis
 * composer.ts:273,335,632 re-authorize between async steps). A bare string is an origin that
 * cannot lose access.
 */
export interface ChatSender {
    origin: string
    allowed(): boolean
}

type From = string | ChatSender | undefined

export interface ConversationSessionInfo {
    cwd?: string
    cliSessionId?: string
    cliToolName?: string
}

export interface ConversationMirror {
    screen(id: string): string[]
    flush(id: string): Promise<void>
    lastOutputAt(id: string): number
    hasExited(id: string): boolean
    showsAwaitingInput(id: string): boolean
    inputBox(id: string): { typed: string; clipped?: boolean; typedRows?: number } | null
}

export interface ConversationServiceDeps {
    session(id: string): ConversationSessionInfo | null
    reader: TranscriptReader
    mirror: ConversationMirror
    hasTerminal(id: string): boolean
    writeInput(id: string, data: string): void
    /**
     * ControlApiService.typeForChat — throws ControlApiError (409 awaiting_input …). `allowed`: asked
     * before the text and before each Enter; false throws `revoked` (F02).
     */
    type(id: string, text: string, allowed?: () => boolean): Promise<boolean>
    /**
     * Which program the terminal's shell runs now (its child processes), null when only the shell is
     * there. A queued message goes only to the program it was queued for: once the agent exits, its
     * text would be a shell command. Without it (tests of other parts) messages are not bound.
     */
    agentProcess?(id: string): Promise<string | null>
    onChange(sessionId: string, revision: number): void
    /** The `/` commands an agent offers in a folder (chatCommands.ts). */
    listCommands?(agent: ConversationAgent, cwd: string | undefined): ChatCommand[]
    /** The Mac's home folder, for `~/` paths in the chat. */
    home?: string
}

interface Watched {
    subscribers: number
    revision: number
    /** what was last reported, to tell a change */
    lastKey: string
    lastScreenAt: number
    working: boolean
    /** the mode the screen shows under the input box; null: it shows none */
    screenMode: string | null
    prompt: PromptMenu | null
    queue: QueueItem[]
    sending: boolean
    /** the last queued message typed that only the terminal can show (ConversationSnapshot.terminalOpened) */
    terminalOpened: { id: string; command: string } | null
}

/**
 * A queued message and what it is bound to: the agent program in front when it was queued, and who
 * sent it (`origin`: a phone's `device:<id>` / `tailscale:<login>`; none from this Mac) — a device
 * disconnected or the phone turned off drops its messages (`dropQueuedFrom`).
 */
interface QueueItem extends QueuedMessage {
    process: string | null
    origin?: string
    /** the sender may still type (ChatSender) — asked again when the queue gets to it */
    allowed?: () => boolean
    /**
     * The conversation it was written in (the session's `cliSessionId` then). The same agent process
     * can move to another one (`/resume`, `/clear`) — the message is not for that one (F03).
     */
    conversation: string | null
}

let queueSequence = 0

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class ConversationService {
    private readonly watched = new Map<string, Watched>()
    /**
     * One lane per session for everything that writes keys (sends, Send now, the queue, card
     * answers, Stop): the next waits until the last is typed, and checks the screen again then.
     * Two devices answering one card at once otherwise read the same highlight and both press ↓.
     * After ovis server/core/input.ts (createInputLane).
     */
    private readonly lanes = new Map<string, Promise<void>>()
    /**
     * The card last answered per session, and the output time when its keys went: until the
     * terminal prints again, the same menu on screen is the one already answered (the agent has
     * not read the keys yet).
     */
    private readonly lastAnswer = new Map<string, { signature: string; outputAt: number }>()
    /**
     * Paths in tool outputs read whole, by session and output: links on the page that the turns do not hold. They
     * count only while that tool is in the chat — a `/resume` or a rewind takes it away, and its links with it.
     */
    private readonly wholeOutputPaths = new Map<string, Map<string, Set<string>>>()
    private timer: NodeJS.Timeout | null = null
    private polling = false

    constructor(private readonly deps: ConversationServiceDeps) {}

    subscribe(sessionId: string): void {
        this.entry(sessionId).subscribers += 1
        this.ensureTimer()
    }

    unsubscribe(sessionId: string): void {
        const entry = this.watched.get(sessionId)
        if (!entry) return
        entry.subscribers = Math.max(0, entry.subscribers - 1)
        this.dropIfIdle(sessionId, entry)
    }

    /** Runs `work` after the session's earlier writes are done. */
    private inLane<T>(sessionId: string, work: () => Promise<T>): Promise<T> {
        const before = this.lanes.get(sessionId) ?? Promise.resolve()
        const run = before.then(work)
        const tail = run.then(
            () => undefined,
            () => undefined
        )
        this.lanes.set(sessionId, tail)
        void tail.then(() => {
            if (this.lanes.get(sessionId) === tail) this.lanes.delete(sessionId)
        })
        return run
    }

    /** The session closed: forget it, queued text included. */
    forget(sessionId: string): void {
        this.watched.delete(sessionId)
        this.lastAnswer.delete(sessionId)
        this.wholeOutputPaths.delete(sessionId)
        this.deps.reader.forget(sessionId)
    }

    async getConversation(sessionId: string, limit = CHAT_TURN_LIMIT): Promise<ConversationSnapshot> {
        const entry = this.entry(sessionId)
        await this.refreshScreen(sessionId, entry)
        const info = this.deps.session(sessionId)
        const base = {
            sessionId,
            ...(info?.cwd ? { cwd: info.cwd } : {}),
            ...(this.deps.home ? { home: this.deps.home } : {}),
            working: entry.working,
            prompt: entry.prompt,
            queued: entry.queue.map(({ id, text }) => ({ id, text })),
            revision: entry.revision,
            meta: null,
            terminalOpened: entry.terminalOpened
        }
        const agent = agentOf(info)
        if (!info?.cliSessionId || agent === null) {
            this.dropIfIdle(sessionId, entry)
            return { ...base, agent, unavailable: 'no-conversation', turns: [], totalTurns: 0, truncated: false }
        }
        try {
            const read = this.deps.reader.read(sessionId, agent, info.cliSessionId, info.cwd)
            this.dropIfIdle(sessionId, entry)
            if (read === null) return { ...base, agent, unavailable: 'not-found', turns: [], totalTurns: 0, truncated: false }
            const turns = read.turns.slice(-Math.max(1, Math.min(limit, 2000)))
            // the screen follows shift+tab at once; the record only names the mode of the last prompt
            const meta = agent === 'claude' && entry.screenMode ? { ...(read.meta ?? { model: null, effort: null }), mode: entry.screenMode } : read.meta
            return { ...base, agent, turns, totalTurns: read.turns.length, truncated: read.truncated, meta }
        } catch (error) {
            console.error('[conversation] read failed', sessionId, error)
            this.dropIfIdle(sessionId, entry)
            return { ...base, agent, unavailable: 'read-failed', turns: [], totalTurns: 0, truncated: false }
        }
    }

    /** `from`: who sends it, when not this Mac (ChatSender). */
    async send(sessionId: string, raw: string, from?: From, options: ChatSendOptions = {}): Promise<ChatSendResult> {
        const sender = senderOf(from)
        const text = raw.replace(/\s+$/, '')
        if (!text.trim()) return { status: 'rejected', reason: 'empty', message: 'Nothing to send.' }
        if (text.length > MAX_TEXT_LENGTH) {
            return { status: 'rejected', reason: 'too_large', message: `Messages are limited to ${MAX_TEXT_LENGTH} characters.` }
        }
        const info = this.deps.session(sessionId)
        if (!info) return { status: 'rejected', reason: 'unknown_session', message: 'This session is gone.' }
        if (!this.deps.hasTerminal(sessionId)) return { status: 'rejected', reason: 'not_running', message: 'The terminal for this session is not running.' }
        if (this.deps.mirror.hasExited(sessionId)) return { status: 'rejected', reason: 'exited', message: 'The shell in this session has exited.' }

        const entry = this.entry(sessionId)
        await this.refreshScreen(sessionId, entry, true)
        let blocked = this.blockedReason(sessionId, entry)
        if (blocked?.status === 'rejected' && blocked.reason === 'input_busy' && options.clearDraft !== undefined) {
            if (sender && !sender.allowed()) {
                this.dropIfIdle(sessionId, entry)
                return REVOKED
            }
            blocked = await this.clearDraft(sessionId, entry, options.clearDraft, blocked)
        }
        if (blocked) {
            this.dropIfIdle(sessionId, entry)
            return blocked
        }
        const process = await this.agentInFront(sessionId)
        if (process === null) {
            this.dropIfIdle(sessionId, entry)
            return NO_AGENT
        }
        // disconnected during the checks above: the revoke hook has already cleared this device's
        // queue, so what is put there now would outlive it
        if (sender && !sender.allowed()) {
            this.dropIfIdle(sessionId, entry)
            return REVOKED
        }
        // working, others waiting, or another message still being typed: it waits its turn,
        // so two sends never type into the terminal at once
        if (entry.working || entry.queue.length > 0 || entry.sending || this.lanes.has(sessionId)) {
            entry.queue.push({
                id: `q${++queueSequence}`,
                text,
                process: process === true ? null : process,
                conversation: info.cliSessionId ?? null,
                ...(sender ? { origin: sender.origin, allowed: sender.allowed } : {})
            })
            this.bump(sessionId, entry)
            this.ensureTimer()
            return { status: 'queued' }
        }
        entry.sending = true
        return this.inLane(sessionId, async () => {
            try {
                if (sender && !sender.allowed()) return REVOKED
                const submitted = await this.deps.type(sessionId, text, sender?.allowed)
                this.bump(sessionId, entry)
                return submitted ? ({ status: 'sent' } as ChatSendResult) : NOT_SUBMITTED
            } catch (error) {
                return rejection(error)
            } finally {
                entry.sending = false
                this.dropIfIdle(sessionId, entry)
            }
        })
    }

    /**
     * Drops what a sender queued, in every session: a phone device disconnected (`device:<id>`), or —
     * with a test — the phone connection turned off. Returns how many were dropped.
     */
    dropQueuedFrom(origin: string | ((origin: string | undefined) => boolean)): number {
        const matches = typeof origin === 'string' ? (from: string | undefined) => from === origin : origin
        let dropped = 0
        for (const [sessionId, entry] of [...this.watched]) {
            const kept = entry.queue.filter((message) => !matches(message.origin))
            if (kept.length === entry.queue.length) continue
            dropped += entry.queue.length - kept.length
            entry.queue = kept
            this.bump(sessionId, entry)
            this.dropIfIdle(sessionId, entry)
        }
        return dropped
    }

    /** A queued terminal-only `/` command went out: the views show the terminal (F18). */
    private noteTerminalCommand(sessionId: string, entry: Watched, message: QueueItem): void {
        const command = terminalCommand(message.text, this.listCommands(sessionId))
        if (command) entry.terminalOpened = { id: message.id, command }
    }

    /** The program in front: its id, null when only the shell is there, true when it cannot be told (no dep). */
    private async agentInFront(sessionId: string): Promise<string | null | true> {
        if (!this.deps.agentProcess) return true
        try {
            return await this.deps.agentProcess(sessionId)
        } catch (error) {
            console.error('[conversation] could not read the program in front', sessionId, error)
            return null
        }
    }

    /** Whether `message` would still reach the program it was queued for. */
    private stillFor(message: QueueItem, front: string | null | true): boolean {
        return front === true || (front !== null && (message.process === null || message.process === front))
    }

    /**
     * Whether the session still shows the conversation `message` was written in. Known only once the
     * stored id changed: ClaudeSessionSync follows Claude’s `/resume`. CodexSessionLocator
     * finds new starts, but TUI `/resume` and `/new` need an explicit connection from the session menu.
     */
    private sameConversation(sessionId: string, message: QueueItem): boolean {
        if (message.conversation === null) return true
        const now = this.deps.session(sessionId)?.cliSessionId ?? null
        return now === null || now === message.conversation
    }

    cancelQueued(sessionId: string): void {
        const entry = this.watched.get(sessionId)
        if (!entry || entry.queue.length === 0) return
        entry.queue.length = 0
        this.bump(sessionId, entry)
        this.dropIfIdle(sessionId, entry)
    }

    /**
     * Drops one queued message (its ✕, or Edit). True when it was still queued and is withdrawn now —
     * false when it already went (or never was), so Edit does not bring back text the agent has.
     */
    discardQueued(sessionId: string, id: string): boolean {
        const entry = this.watched.get(sessionId)
        const index = entry?.queue.findIndex((message) => message.id === id) ?? -1
        if (!entry || index < 0) return false
        entry.queue.splice(index, 1)
        this.bump(sessionId, entry)
        this.dropIfIdle(sessionId, entry)
        return true
    }

    /**
     * "↑ Send now": types one queued message while the agent still works. The agent decides when
     * it reads it (Claude Code holds it for its next step). Refused like any send while a question
     * is on screen or the terminal's input line holds text — then it stays queued.
     */
    async sendQueuedNow(sessionId: string, id: string, from?: From): Promise<ChatSendResult> {
        if (!this.watched.get(sessionId)?.queue.some((item) => item.id === id)) {
            return { status: 'rejected', reason: 'empty', message: 'That message is no longer waiting.' }
        }
        return this.inLane(sessionId, () => this.sendQueuedNowInLane(sessionId, id, senderOf(from)))
    }

    private async sendQueuedNowInLane(sessionId: string, id: string, sender: ChatSender | null): Promise<ChatSendResult> {
        // looked up again: what waited in the lane may have been sent, dropped or forgotten meanwhile
        const entry = this.watched.get(sessionId)
        const message = entry?.queue.find((item) => item.id === id)
        if (!entry || !message) return { status: 'rejected', reason: 'empty', message: 'That message is no longer waiting.' }
        if (!this.deps.hasTerminal(sessionId)) return { status: 'rejected', reason: 'not_running', message: 'The terminal for this session is not running.' }
        if (this.deps.mirror.hasExited(sessionId)) return { status: 'rejected', reason: 'exited', message: 'The shell in this session has exited.' }
        await this.refreshScreen(sessionId, entry, true)
        const blocked = this.blockedReason(sessionId, entry)
        if (blocked) return blocked
        if (!this.sameConversation(sessionId, message)) {
            const at = entry.queue.indexOf(message)
            if (at >= 0) entry.queue.splice(at, 1)
            console.warn('[conversation] dropped a queued message: the agent moved to another conversation', sessionId)
            this.bump(sessionId, entry)
            this.dropIfIdle(sessionId, entry)
            return CONVERSATION_CHANGED
        }
        if (!this.stillFor(message, await this.agentInFront(sessionId))) {
            const at = entry.queue.indexOf(message)
            if (at >= 0) entry.queue.splice(at, 1)
            console.warn('[conversation] dropped a queued message: the agent it was written for is gone', sessionId)
            this.bump(sessionId, entry)
            this.dropIfIdle(sessionId, entry)
            return NO_AGENT
        }
        const index = entry.queue.indexOf(message)
        if (index < 0) return { status: 'rejected', reason: 'empty', message: 'That message is no longer waiting.' }
        // the tap and the message's own sender both still allowed (a phone may tap a Mac's message)
        const allowed = (): boolean => (sender?.allowed() ?? true) && (message.allowed?.() ?? true)
        if (!allowed()) return REVOKED
        entry.queue.splice(index, 1)
        entry.sending = true
        try {
            // not put back when unsubmitted: the text is in the terminal's box, a later send would type it twice
            if (!(await this.deps.type(sessionId, message.text, allowed))) return NOT_SUBMITTED
            this.noteTerminalCommand(sessionId, entry, message)
            return { status: 'sent' }
        } catch (error) {
            entry.queue.splice(Math.min(index, entry.queue.length), 0, message)
            return rejection(error)
        } finally {
            entry.sending = false
            this.bump(sessionId, entry)
            this.dropIfIdle(sessionId, entry)
        }
    }

    /**
     * Stop: Esc to the agent's terminal — only while its screen shows a turn in progress
     * ("esc to interrupt"). At rest Esc would land in whatever the agent shows (a menu, the input
     * box), so it is refused then.
     */
    async interrupt(sessionId: string, from?: From): Promise<InterruptResult> {
        return this.inLane(sessionId, () => this.interruptInLane(sessionId, senderOf(from)))
    }

    private async interruptInLane(sessionId: string, sender: ChatSender | null): Promise<InterruptResult> {
        if (!this.deps.hasTerminal(sessionId) || this.deps.mirror.hasExited(sessionId)) {
            return { status: 'rejected', reason: 'not_running', message: 'The terminal for this session is not running.' }
        }
        const entry = this.entry(sessionId)
        await this.refreshScreen(sessionId, entry, true)
        if (!entry.working) {
            this.dropIfIdle(sessionId, entry)
            return { status: 'rejected', reason: 'not_working', message: 'The agent is not working on a turn.' }
        }
        if (sender && !sender.allowed()) {
            this.dropIfIdle(sessionId, entry)
            return REVOKED
        }
        this.deps.writeInput(sessionId, INTERRUPT_KEY)
        this.bump(sessionId, entry)
        this.dropIfIdle(sessionId, entry)
        return { status: 'stopped' }
    }

    /** A picture the conversation holds (an image part's or a tool's `ref`), as a data: URL. */
    async getImage(sessionId: string, ref: string): Promise<string | null> {
        return this.withReader(sessionId, () => this.deps.reader.image(sessionId, ref))
    }

    /** The whole output of a tool call the chat cut. */
    async getToolOutput(sessionId: string, ref: string): Promise<string | null> {
        const output = await this.withReader(sessionId, () => this.deps.reader.toolOutput(sessionId, ref))
        // shown whole, its paths are links too — the turns only hold the cut part
        if (output) {
            const named = new Set<string>()
            addLinkedText(named, output, this.deps.session(sessionId)?.cwd, this.deps.home)
            const outputs = this.wholeOutputPaths.get(sessionId) ?? new Map<string, Set<string>>()
            outputs.set(ref, named)
            this.wholeOutputPaths.set(sessionId, outputs)
        }
        return output
    }

    /**
     * The files this session's chat shows as links, and its folder: what a phone may ask for (phoneFiles.ts).
     * Read anew for each request: a chat nobody has open has a record too, and the answer follows the conversation.
     */
    async mentionedPaths(sessionId: string): Promise<{ paths: ReadonlySet<string>; cwd?: string }> {
        const info = this.deps.session(sessionId)
        const agent = agentOf(info)
        const none = { paths: new Set<string>(), ...(info?.cwd ? { cwd: info.cwd } : {}) }
        if (!info?.cliSessionId || !agent) return none
        const entry = this.entry(sessionId)
        try {
            const read = this.deps.reader.read(sessionId, agent, info.cliSessionId, info.cwd)
            if (!read) return none
            // this read took the new records: the next poll will see nothing new, so whoever watches is told here
            if (read.changed) this.bump(sessionId, entry)
            const paths = mentionedPaths(read.turns, info.cwd, this.deps.home)
            const outputs = this.wholeOutputPaths.get(sessionId)
            if (outputs) {
                for (const turn of read.turns) {
                    for (const part of turn.parts) {
                        // the ref the chat's «Show all» asks with (WorkBlock.tsx)
                        const ref = part.kind === 'tool' ? part.output_ref ?? part.call_id : undefined
                        for (const path of (ref && outputs.get(ref)) || []) paths.add(path)
                    }
                }
            }
            return { ...none, paths }
        } catch (error) {
            console.error('[conversation] mentions failed', sessionId, error)
            return none
        } finally {
            this.dropIfIdle(sessionId, entry)
        }
    }

    /** The `/` commands the session's agent offers in its folder. */
    listCommands(sessionId: string): ChatCommand[] {
        const info = this.deps.session(sessionId)
        const agent = agentOf(info)
        if (!agent || !this.deps.listCommands) return []
        return this.deps.listCommands(agent, info?.cwd)
    }

    /** Runs `find` with the session's transcript read (a view that is not open may have none yet). */
    private async withReader(sessionId: string, find: () => Promise<string | null>): Promise<string | null> {
        const info = this.deps.session(sessionId)
        const agent = agentOf(info)
        if (!info?.cliSessionId || !agent) return null
        const entry = this.entry(sessionId)
        try {
            this.deps.reader.read(sessionId, agent, info.cliSessionId, info.cwd)
            return await find()
        } catch (error) {
            console.error('[conversation] record lookup failed', sessionId, error)
            return null
        } finally {
            this.dropIfIdle(sessionId, entry)
        }
    }

    /**
     * Answers the card with keys — only when the screen still shows the menu the
     * card was drawn from (same question, options, highlighted option). The
     * person may have answered in the terminal already, or the agent moved on.
     */
    async answerPrompt(sessionId: string, answer: PromptAnswer, from?: From): Promise<PromptAnswerResult> {
        return this.inLane(sessionId, () => this.answerPromptInLane(sessionId, answer, senderOf(from)))
    }

    private async answerPromptInLane(sessionId: string, answer: PromptAnswer, sender: ChatSender | null): Promise<PromptAnswerResult> {
        if (sender && !sender.allowed()) return REVOKED
        if (!this.deps.hasTerminal(sessionId) || this.deps.mirror.hasExited(sessionId)) {
            return { status: 'rejected', reason: 'not_running', message: 'The terminal for this session is not running.' }
        }
        await this.deps.mirror.flush(sessionId)
        const current = readPrompt(this.deps.mirror.screen(sessionId), agentOf(this.deps.session(sessionId)) ?? 'claude')
        const answered = this.lastAnswer.get(sessionId)
        // the same menu with nothing printed since its answer went: the agent has not read those keys yet
        const alreadyAnswered = answered?.signature === answer.signature && answered.outputAt === this.deps.mirror.lastOutputAt(sessionId)
        if (!current || current.signature !== answer.signature || alreadyAnswered) {
            const entry = this.entry(sessionId)
            await this.refreshScreen(sessionId, entry, true)
            this.bump(sessionId, entry)
            this.dropIfIdle(sessionId, entry)
            return { status: 'rejected', reason: 'prompt_changed', message: 'The question on screen changed. Look at it again before answering.' }
        }
        if (!current.answerable) return { status: 'rejected', reason: 'not_answerable', message: 'Answer this question in the terminal.' }
        let steps
        try {
            steps = answerSteps(current, answer)
        } catch (error) {
            if (error instanceof PromptAnswerError) return { status: 'rejected', reason: 'bad_answer', message: error.message }
            throw error
        }
        this.lastAnswer.set(sessionId, { signature: current.signature, outputAt: this.deps.mirror.lastOutputAt(sessionId) })
        const entry = this.entry(sessionId)
        entry.sending = true
        const target = 'customText' in answer ? current.options.findIndex((option) => option.custom) : answer.optionIndex
        try {
            let confirmed = false
            for (const [index, step] of steps.entries()) {
                if (index > 0) await sleep(KEY_GAP_MS)
                // disconnected between two keys: stop before the next (an Enter would pick an option)
                if (sender && !sender.allowed()) return REVOKED
                const moves = 'key' in step && (step.key === KEYS.up || step.key === KEYS.down)
                // the moves are done: a key typed in the raw terminal (the Mac, a phone's Terminal tab —
                // outside this lane) may have moved the highlight between ours. Enter only on the option meant.
                if (!moves && !confirmed) {
                    if (!(await this.highlightsOption(sessionId, current, target))) {
                        this.lastAnswer.delete(sessionId)
                        const entry = this.entry(sessionId)
                        await this.refreshScreen(sessionId, entry, true)
                        this.bump(sessionId, entry)
                        console.warn('[conversation] card answer stopped before Enter: the highlight is not on the option meant', sessionId)
                        return { status: 'rejected', reason: 'prompt_changed', message: 'The highlighted option changed while answering. Look at the question again.' }
                    }
                    confirmed = true
                    if (sender && !sender.allowed()) return REVOKED
                }
                this.deps.writeInput(sessionId, 'key' in step ? step.key : step.text)
            }
        } finally {
            entry.sending = false
            this.dropIfIdle(sessionId, entry)
        }
        return { status: 'answered' }
    }

    /**
     * Whether the screen shows `menu` (same question and options) with option `target` highlighted,
     * waiting up to CONFIRM_MS for the agent to draw the keys already sent.
     */
    private async highlightsOption(sessionId: string, menu: PromptMenu, target: number): Promise<boolean> {
        const agent = agentOf(this.deps.session(sessionId)) ?? 'claude'
        const deadline = Date.now() + CONFIRM_MS
        for (;;) {
            await this.deps.mirror.flush(sessionId)
            const now = readPrompt(this.deps.mirror.screen(sessionId), agent)
            const same =
                now !== null &&
                now.question === menu.question &&
                now.options.length === menu.options.length &&
                now.options.every((option, index) => option.label === menu.options[index].label)
            if (!same) return false
            const selected = now.options.findIndex((option) => option.selected)
            if (selected === target) return true
            if (Date.now() >= deadline) return false
            await sleep(CONFIRM_POLL_MS)
        }
    }

    private blockedReason(sessionId: string, entry: Watched): ChatSendResult | null {
        if (entry.prompt || this.deps.mirror.showsAwaitingInput(sessionId) && !entry.working) {
            return {
                status: 'rejected',
                reason: 'awaiting_input',
                message: 'The agent is asking a question. Answer it first — Enter would pick the highlighted option.'
            }
        }
        const box = this.deps.mirror.inputBox(sessionId)
        const claude = agentOf(this.deps.session(sessionId)) === 'claude'
        // Only Claude's box is read from its rules; a lone rule on a Codex screen is its output.
        const clipped = box?.clipped === true && claude
        if (box?.typed.trim() || clipped) {
            const draft = claude ? clearableDraft(box) : null
            return {
                status: 'rejected',
                reason: 'input_busy',
                message: 'The terminal input line already has text. Send or clear it in the terminal first, so the two do not mix.',
                ...(draft !== null ? { draft } : {})
            }
        }
        return null
    }

    /**
     * Empties Claude's input box for a send the person agreed to: only while it holds exactly
     * `expected`, with Ctrl+K then Ctrl+U (the row after the cursor, then before it — ovis
     * CLAUDE_CLEAR_INPUT_KEYS, measured on 2.1.295; Ctrl+Y puts it back). Returns what still
     * blocks the send, or null once the box reads empty.
     */
    private async clearDraft(sessionId: string, entry: Watched, expected: string, refused: ChatSendResult): Promise<ChatSendResult | null> {
        const draft = clearableDraft(this.deps.mirror.inputBox(sessionId))
        if (draft === null || draft !== expected) return refused
        if (!(await this.emptyBox(sessionId))) {
            return { status: 'rejected', reason: 'input_busy', message: 'The terminal input line did not empty. Clear it in the terminal.' }
        }
        await this.refreshScreen(sessionId, entry, true)
        return this.blockedReason(sessionId, entry)
    }

    /** Ctrl+K, Ctrl+U, then waits for the box to read empty. False when it did not in time. */
    private async emptyBox(sessionId: string): Promise<boolean> {
        for (const key of CLEAR_INPUT_KEYS) this.deps.writeInput(sessionId, key)
        const deadline = Date.now() + CLEAR_WAIT_MS
        for (;;) {
            await this.deps.mirror.flush(sessionId)
            if (!this.deps.mirror.inputBox(sessionId)?.typed.trim()) return true
            if (Date.now() >= deadline) return false
            await sleep(CLEAR_POLL_MS)
        }
    }

    /**
     * Chat → Terminal (4b9cb0c2): the chat's unsent text into Claude's input box, without Enter — never
     * over text already there, never onto a question. Several lines (or a long one) go as one bracketed
     * paste, so no line is sent on its own and a long line is not cut (edge-audit 7). Claude only.
     */
    async placeDraftInTerminal(sessionId: string, raw: string, from?: From): Promise<DraftToTerminalResult> {
        const sender = senderOf(from)
        const text = raw.replace(/\s+$/, '')
        if (!text.trim()) return { status: 'refused', reason: 'empty' }
        if (text.length > MAX_TEXT_LENGTH) return { status: 'refused', reason: 'too_large' }
        const info = this.deps.session(sessionId)
        if (agentOf(info) !== 'claude') return { status: 'unsupported' }
        if (!this.deps.hasTerminal(sessionId) || this.deps.mirror.hasExited(sessionId)) return { status: 'refused', reason: 'not_running' }
        const entry = this.entry(sessionId)
        try {
            await this.refreshScreen(sessionId, entry, true)
            const blocked = this.blockedReason(sessionId, entry)
            if (blocked?.status === 'rejected' && blocked.reason === 'awaiting_input') return { status: 'refused', reason: 'awaiting_input' }
            if (blocked?.status === 'rejected' && blocked.reason === 'input_busy') return { status: 'busy', ...(blocked.draft !== undefined ? { draft: blocked.draft } : {}) }
            if ((await this.agentInFront(sessionId)) === null) return { status: 'refused', reason: 'no_agent' }
            if (sender && !sender.allowed()) return { status: 'refused', reason: 'revoked' }
            const paste = text.includes('\n') || text.length > TYPED_LINE_MAX
            this.deps.writeInput(sessionId, paste ? `\x1b[200~${text}\x1b[201~` : text)
            return { status: 'placed' }
        } finally {
            this.dropIfIdle(sessionId, entry)
        }
    }

    /**
     * Terminal → Chat (4b9cb0c2): a one-row draft in Claude's box moves out (Ctrl+K, Ctrl+U) for the chat
     * to take. More rows, bash mode or a paste placeholder stay — those keys edit one row. Claude only.
     */
    async takeTerminalDraft(sessionId: string, from?: From): Promise<DraftFromTerminalResult> {
        const sender = senderOf(from)
        if (agentOf(this.deps.session(sessionId)) !== 'claude') return { status: 'unsupported' }
        if (!this.deps.hasTerminal(sessionId) || this.deps.mirror.hasExited(sessionId)) return { status: 'empty' }
        await this.deps.mirror.flush(sessionId)
        const box = this.deps.mirror.inputBox(sessionId)
        if (!box || (!box.typed.trim() && !box.clipped)) return { status: 'empty' }
        const draft = clearableDraft(box)
        if (draft === null) return { status: 'left', reason: box.clipped || (box.typedRows ?? 0) > 1 ? 'several_lines' : 'kept' }
        if (sender && !sender.allowed()) return { status: 'left', reason: 'kept' }
        if (!(await this.emptyBox(sessionId))) return { status: 'left', reason: 'not_cleared' }
        return { status: 'moved', text: draft }
    }

    private entry(sessionId: string): Watched {
        let entry = this.watched.get(sessionId)
        if (!entry) {
            entry = { subscribers: 0, revision: 1, lastKey: '', lastScreenAt: -1, working: false, screenMode: null, prompt: null, queue: [], sending: false, terminalOpened: null }
            this.watched.set(sessionId, entry)
        }
        return entry
    }

    private dropIfIdle(sessionId: string, entry: Watched): void {
        if (entry.subscribers > 0 || entry.queue.length > 0 || entry.sending) return
        this.watched.delete(sessionId)
        this.deps.reader.forget(sessionId)
        if (this.watched.size === 0) this.stopTimer()
    }

    private bump(sessionId: string, entry: Watched): void {
        entry.revision += 1
        if (entry.subscribers > 0) this.deps.onChange(sessionId, entry.revision)
    }

    /**
     * Working and the menu, re-read only when the terminal printed since the last read (`force`:
     * always). The mirror parses what arrives asynchronously: it is flushed first, and only the
     * output time it was flushed up to counts as read — a screen read before it is drawn would be
     * kept until the next output (a question card staying after its answer, or never showing).
     */
    private async refreshScreen(sessionId: string, entry: Watched, force = false): Promise<void> {
        const outputAt = this.deps.mirror.lastOutputAt(sessionId)
        if (!force && outputAt === entry.lastScreenAt) return
        await this.deps.mirror.flush(sessionId)
        entry.lastScreenAt = outputAt
        const screen = this.deps.mirror.screen(sessionId)
        entry.working = screen.some(isBusyRow)
        entry.screenMode = screenAgentMode(screen)
        entry.prompt = entry.working ? null : readPrompt(screen, agentOf(this.deps.session(sessionId)) ?? 'claude')
    }

    private ensureTimer(): void {
        if (this.timer) return
        this.timer = setInterval(() => void this.poll(), POLL_MS)
    }

    private stopTimer(): void {
        if (!this.timer) return
        clearInterval(this.timer)
        this.timer = null
    }

    private async poll(): Promise<void> {
        // a round waits on flushes and typing: the next tick does not start another beside it
        if (this.polling) return
        this.polling = true
        try {
            await this.pollRound()
        } finally {
            this.polling = false
        }
    }

    private async pollRound(): Promise<void> {
        for (const [sessionId, entry] of [...this.watched]) {
            if (!this.deps.session(sessionId)) {
                this.forget(sessionId)
                continue
            }
            await this.refreshScreen(sessionId, entry)
            let transcriptChanged = false
            const info = this.deps.session(sessionId)
            const agent = agentOf(info)
            if (entry.subscribers > 0 && info?.cliSessionId && agent) {
                try {
                    transcriptChanged = this.deps.reader.read(sessionId, agent, info.cliSessionId, info.cwd)?.changed ?? false
                } catch (error) {
                    console.error('[conversation] poll read failed', sessionId, error)
                }
            }
            const key = JSON.stringify([info?.cliSessionId ?? null, entry.working, entry.screenMode ?? null, entry.prompt?.signature ?? null, entry.queue.map((message) => message.id)])
            if (transcriptChanged || key !== entry.lastKey) {
                entry.lastKey = key
                this.bump(sessionId, entry)
            }
            await this.drainQueue(sessionId, entry)
        }
        if (this.watched.size === 0) this.stopTimer()
    }

    /** Sends the first queued message once the turn is over and the screen has been quiet. */
    private async drainQueue(sessionId: string, entry: Watched): Promise<void> {
        if (entry.queue.length === 0 || entry.sending || entry.working || entry.prompt) return
        if (Date.now() - this.deps.mirror.lastOutputAt(sessionId) < QUEUE_QUIET_MS) return
        if (!this.deps.hasTerminal(sessionId) || this.deps.mirror.hasExited(sessionId)) {
            entry.queue.length = 0
            this.bump(sessionId, entry)
            return
        }
        if (this.lanes.has(sessionId)) return
        await this.inLane(sessionId, async () => {
            await this.refreshScreen(sessionId, entry, true)
            if (entry.queue.length === 0 || entry.working || entry.prompt || this.blockedReason(sessionId, entry)) return
            // the agent exited (only its shell left) or another program took its place: what was
            // written for it would run as a command there — dropped, never typed
            const front = await this.agentInFront(sessionId)
            // also what a device sent and lost access to since (revoked after its revoke hook ran)
            const kept = entry.queue.filter(
                (message) => this.stillFor(message, front) && this.sameConversation(sessionId, message) && (message.allowed?.() ?? true)
            )
            if (kept.length !== entry.queue.length) {
                console.warn(
                    `[conversation] dropped ${entry.queue.length - kept.length} queued message(s): the agent or conversation they were written for is gone, or their sender lost access`,
                    sessionId
                )
                entry.queue = kept
                this.bump(sessionId, entry)
                if (kept.length === 0) {
                    this.dropIfIdle(sessionId, entry)
                    return
                }
            }
            const message = entry.queue.shift()!
            entry.sending = true
            try {
                // left in the terminal's box: not queued again (typing it twice), the person sees it there
                if (!(await this.deps.type(sessionId, message.text, message.allowed))) console.warn('[conversation] queued message left unsubmitted in the input box', sessionId)
                else this.noteTerminalCommand(sessionId, entry, message)
            } catch (error) {
                // A question appeared between the check and the typing: put it back and wait.
                const code = (error as { code?: string }).code
                if (code === 'awaiting_input') entry.queue.unshift(message)
                else if (code === 'revoked') console.warn('[conversation] dropped a queued message: its sender lost access', sessionId)
                else console.error('[conversation] queued send failed', sessionId, error)
            } finally {
                entry.sending = false
                this.bump(sessionId, entry)
                this.dropIfIdle(sessionId, entry)
            }
        })
    }
}

function senderOf(from: From): ChatSender | null {
    if (from === undefined) return null
    return typeof from === 'string' ? { origin: from, allowed: () => true } : from
}

/** Longer than this, one line goes as a paste: Claude reads a long typed line as pasted chunks and keeps the tail (ovis composer.ts TYPED_LINE_MAX, #1174). */
const TYPED_LINE_MAX = 200
/** Ctrl+K, Ctrl+U: what empties a one-row Claude input box. */
const CLEAR_INPUT_KEYS = ['\x0b', '\x15']
const CLEAR_WAIT_MS = 1500
const CLEAR_POLL_MS = 50
/** A paste or an image Claude folded into a placeholder stands for more than the box shows. */
const DRAFT_PLACEHOLDER = /\[(?:Pasted text #\d+|Image #\d+)/

/**
 * The typed text the chat may offer to clear (ovis claudeClearableDraft, MIT): one row of a `❯`
 * box. Not a box clipped by the screen, not bash mode (`!` in place of `❯`, its own Backspace),
 * not a placeholder. Null otherwise.
 */
function clearableDraft(box: { typed: string; clipped?: boolean; typedRows?: number } | null): string | null {
    if (!box || box.clipped || box.typedRows !== 1) return null
    const typed = box.typed.trim()
    if (!typed || typed.startsWith('!') || DRAFT_PLACEHOLDER.test(typed)) return null
    return typed
}

function agentOf(info: ConversationSessionInfo | null): ConversationAgent | null {
    if (!info?.cliToolName) return null
    return info.cliToolName === 'codex' ? 'codex' : info.cliToolName === 'claude' ? 'claude' : null
}

function rejection(error: unknown): ChatSendResult {
    const code = (error as { code?: string }).code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'awaiting_input') return { status: 'rejected', reason: 'awaiting_input', message }
    if (code === 'revoked') return REVOKED
    if (code === 'exited') return { status: 'rejected', reason: 'exited', message }
    if (code === 'not_found') return { status: 'rejected', reason: 'unknown_session', message }
    return { status: 'rejected', reason: 'not_running', message }
}
