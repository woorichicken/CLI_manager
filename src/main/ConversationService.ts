import type {
    ChatCommand,
    ChatSendResult,
    ConversationAgent,
    ConversationSnapshot,
    InterruptResult,
    PromptAnswer,
    PromptAnswerResult,
    PromptMenu,
    QueuedMessage
} from '../shared/conversation'
import { CHAT_TURN_LIMIT, MAX_CHAT_TEXT_LENGTH } from '../shared/conversation'
import { answerSteps, PromptAnswerError, readPrompt } from './promptScreen'
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
const BUSY = /esc to interrupt/i

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
    inputBox(id: string): { typed: string } | null
}

export interface ConversationServiceDeps {
    session(id: string): ConversationSessionInfo | null
    reader: TranscriptReader
    mirror: ConversationMirror
    hasTerminal(id: string): boolean
    writeInput(id: string, data: string): void
    /** ControlApiService.typeForChat — throws ControlApiError (409 awaiting_input …) */
    type(id: string, text: string): Promise<boolean>
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
    prompt: PromptMenu | null
    queue: QueuedMessage[]
    sending: boolean
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
            queued: entry.queue.map((message) => ({ ...message })),
            revision: entry.revision,
            meta: null
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
            return { ...base, agent, turns, totalTurns: read.turns.length, truncated: read.truncated, meta: read.meta }
        } catch (error) {
            console.error('[conversation] read failed', sessionId, error)
            this.dropIfIdle(sessionId, entry)
            return { ...base, agent, unavailable: 'read-failed', turns: [], totalTurns: 0, truncated: false }
        }
    }

    async send(sessionId: string, raw: string): Promise<ChatSendResult> {
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
        const blocked = this.blockedReason(sessionId, entry)
        if (blocked) {
            this.dropIfIdle(sessionId, entry)
            return blocked
        }
        // working, others waiting, or another message still being typed: it waits its turn,
        // so two sends never type into the terminal at once
        if (entry.working || entry.queue.length > 0 || entry.sending || this.lanes.has(sessionId)) {
            entry.queue.push({ id: `q${++queueSequence}`, text })
            this.bump(sessionId, entry)
            this.ensureTimer()
            return { status: 'queued' }
        }
        entry.sending = true
        return this.inLane(sessionId, async () => {
            try {
                await this.deps.type(sessionId, text)
                this.bump(sessionId, entry)
                return { status: 'sent' } as ChatSendResult
            } catch (error) {
                return rejection(error)
            } finally {
                entry.sending = false
                this.dropIfIdle(sessionId, entry)
            }
        })
    }

    cancelQueued(sessionId: string): void {
        const entry = this.watched.get(sessionId)
        if (!entry || entry.queue.length === 0) return
        entry.queue.length = 0
        this.bump(sessionId, entry)
        this.dropIfIdle(sessionId, entry)
    }

    /** Drops one queued message (its ✕). */
    discardQueued(sessionId: string, id: string): void {
        const entry = this.watched.get(sessionId)
        const index = entry?.queue.findIndex((message) => message.id === id) ?? -1
        if (!entry || index < 0) return
        entry.queue.splice(index, 1)
        this.bump(sessionId, entry)
        this.dropIfIdle(sessionId, entry)
    }

    /**
     * "↑ Send now": types one queued message while the agent still works. The agent decides when
     * it reads it (Claude Code holds it for its next step). Refused like any send while a question
     * is on screen or the terminal's input line holds text — then it stays queued.
     */
    async sendQueuedNow(sessionId: string, id: string): Promise<ChatSendResult> {
        if (!this.watched.get(sessionId)?.queue.some((item) => item.id === id)) {
            return { status: 'rejected', reason: 'empty', message: 'That message is no longer waiting.' }
        }
        return this.inLane(sessionId, () => this.sendQueuedNowInLane(sessionId, id))
    }

    private async sendQueuedNowInLane(sessionId: string, id: string): Promise<ChatSendResult> {
        // looked up again: what waited in the lane may have been sent, dropped or forgotten meanwhile
        const entry = this.watched.get(sessionId)
        const message = entry?.queue.find((item) => item.id === id)
        if (!entry || !message) return { status: 'rejected', reason: 'empty', message: 'That message is no longer waiting.' }
        if (!this.deps.hasTerminal(sessionId)) return { status: 'rejected', reason: 'not_running', message: 'The terminal for this session is not running.' }
        if (this.deps.mirror.hasExited(sessionId)) return { status: 'rejected', reason: 'exited', message: 'The shell in this session has exited.' }
        await this.refreshScreen(sessionId, entry, true)
        const blocked = this.blockedReason(sessionId, entry)
        if (blocked) return blocked
        const index = entry.queue.indexOf(message)
        if (index < 0) return { status: 'rejected', reason: 'empty', message: 'That message is no longer waiting.' }
        entry.queue.splice(index, 1)
        entry.sending = true
        try {
            await this.deps.type(sessionId, message.text)
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
    async interrupt(sessionId: string): Promise<InterruptResult> {
        return this.inLane(sessionId, () => this.interruptInLane(sessionId))
    }

    private async interruptInLane(sessionId: string): Promise<InterruptResult> {
        if (!this.deps.hasTerminal(sessionId) || this.deps.mirror.hasExited(sessionId)) {
            return { status: 'rejected', reason: 'not_running', message: 'The terminal for this session is not running.' }
        }
        const entry = this.entry(sessionId)
        await this.refreshScreen(sessionId, entry, true)
        if (!entry.working) {
            this.dropIfIdle(sessionId, entry)
            return { status: 'rejected', reason: 'not_working', message: 'The agent is not working on a turn.' }
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
        return this.withReader(sessionId, () => this.deps.reader.toolOutput(sessionId, ref))
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
    async answerPrompt(sessionId: string, answer: PromptAnswer): Promise<PromptAnswerResult> {
        return this.inLane(sessionId, () => this.answerPromptInLane(sessionId, answer))
    }

    private async answerPromptInLane(sessionId: string, answer: PromptAnswer): Promise<PromptAnswerResult> {
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
        try {
            for (const [index, step] of steps.entries()) {
                if (index > 0) await sleep(KEY_GAP_MS)
                this.deps.writeInput(sessionId, 'key' in step ? step.key : step.text)
            }
        } finally {
            entry.sending = false
            this.dropIfIdle(sessionId, entry)
        }
        return { status: 'answered' }
    }

    private blockedReason(sessionId: string, entry: Watched): ChatSendResult | null {
        if (entry.prompt || this.deps.mirror.showsAwaitingInput(sessionId) && !entry.working) {
            return {
                status: 'rejected',
                reason: 'awaiting_input',
                message: 'The agent is asking a question. Answer it first — Enter would pick the highlighted option.'
            }
        }
        const typed = this.deps.mirror.inputBox(sessionId)?.typed.trim()
        if (typed) {
            return {
                status: 'rejected',
                reason: 'input_busy',
                message: 'The terminal input line already has text. Send or clear it in the terminal first, so the two do not mix.'
            }
        }
        return null
    }

    private entry(sessionId: string): Watched {
        let entry = this.watched.get(sessionId)
        if (!entry) {
            entry = { subscribers: 0, revision: 1, lastKey: '', lastScreenAt: -1, working: false, prompt: null, queue: [], sending: false }
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
        entry.working = screen.some((line) => BUSY.test(line))
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
            const key = JSON.stringify([info?.cliSessionId ?? null, entry.working, entry.prompt?.signature ?? null, entry.queue.map((message) => message.id)])
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
            const message = entry.queue.shift()!
            entry.sending = true
            try {
                await this.deps.type(sessionId, message.text)
            } catch (error) {
                // A question appeared between the check and the typing: put it back and wait.
                if ((error as { code?: string }).code === 'awaiting_input') entry.queue.unshift(message)
                else console.error('[conversation] queued send failed', sessionId, error)
            } finally {
                entry.sending = false
                this.bump(sessionId, entry)
                this.dropIfIdle(sessionId, entry)
            }
        })
    }
}

function agentOf(info: ConversationSessionInfo | null): ConversationAgent | null {
    if (!info?.cliToolName) return null
    return info.cliToolName === 'codex' ? 'codex' : info.cliToolName === 'claude' ? 'claude' : null
}

function rejection(error: unknown): ChatSendResult {
    const code = (error as { code?: string }).code
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'awaiting_input') return { status: 'rejected', reason: 'awaiting_input', message }
    if (code === 'exited') return { status: 'rejected', reason: 'exited', message }
    if (code === 'not_found') return { status: 'rejected', reason: 'unknown_session', message }
    return { status: 'rejected', reason: 'not_running', message }
}
