import type {
    ChatSendResult,
    ConversationAgent,
    ConversationSnapshot,
    PromptAnswer,
    PromptAnswerResult,
    PromptMenu
} from '../shared/conversation'
import { CHAT_TURN_LIMIT } from '../shared/conversation'
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
const MAX_TEXT_LENGTH = 100_000
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
}

interface Watched {
    subscribers: number
    revision: number
    /** what was last reported, to tell a change */
    lastKey: string
    lastScreenAt: number
    working: boolean
    prompt: PromptMenu | null
    queue: string[]
    sending: boolean
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class ConversationService {
    private readonly watched = new Map<string, Watched>()
    private timer: NodeJS.Timeout | null = null

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

    /** The session closed: forget it, queued text included. */
    forget(sessionId: string): void {
        this.watched.delete(sessionId)
        this.deps.reader.forget(sessionId)
    }

    async getConversation(sessionId: string, limit = CHAT_TURN_LIMIT): Promise<ConversationSnapshot> {
        const entry = this.entry(sessionId)
        this.readScreen(sessionId, entry, true)
        const base = {
            sessionId,
            working: entry.working,
            prompt: entry.prompt,
            queued: [...entry.queue],
            revision: entry.revision
        }
        const info = this.deps.session(sessionId)
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
            return { ...base, agent, turns, totalTurns: read.turns.length, truncated: read.truncated }
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

        await this.deps.mirror.flush(sessionId)
        const entry = this.entry(sessionId)
        this.readScreen(sessionId, entry, true)
        const blocked = this.blockedReason(sessionId, entry)
        if (blocked) {
            this.dropIfIdle(sessionId, entry)
            return blocked
        }
        if (entry.working || entry.queue.length > 0) {
            entry.queue.push(text)
            this.bump(sessionId, entry)
            this.ensureTimer()
            return { status: 'queued' }
        }
        try {
            await this.deps.type(sessionId, text)
            this.bump(sessionId, entry)
            return { status: 'sent' }
        } catch (error) {
            return rejection(error)
        } finally {
            this.dropIfIdle(sessionId, entry)
        }
    }

    cancelQueued(sessionId: string): void {
        const entry = this.watched.get(sessionId)
        if (!entry || entry.queue.length === 0) return
        entry.queue.length = 0
        this.bump(sessionId, entry)
        this.dropIfIdle(sessionId, entry)
    }

    /**
     * Answers the card with keys — only when the screen still shows the menu the
     * card was drawn from (same question, options, highlighted option). The
     * person may have answered in the terminal already, or the agent moved on.
     */
    async answerPrompt(sessionId: string, answer: PromptAnswer): Promise<PromptAnswerResult> {
        if (!this.deps.hasTerminal(sessionId) || this.deps.mirror.hasExited(sessionId)) {
            return { status: 'rejected', reason: 'not_running', message: 'The terminal for this session is not running.' }
        }
        await this.deps.mirror.flush(sessionId)
        const current = readPrompt(this.deps.mirror.screen(sessionId), agentOf(this.deps.session(sessionId)) ?? 'claude')
        if (!current || current.signature !== answer.signature) {
            const entry = this.entry(sessionId)
            this.readScreen(sessionId, entry, true)
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
        for (const [index, step] of steps.entries()) {
            if (index > 0) await sleep(KEY_GAP_MS)
            this.deps.writeInput(sessionId, 'key' in step ? step.key : step.text)
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

    /** Working and the menu, re-read only when the terminal printed since the last read. */
    private readScreen(sessionId: string, entry: Watched, force = false): void {
        const outputAt = this.deps.mirror.lastOutputAt(sessionId)
        if (!force && outputAt === entry.lastScreenAt) return
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
        for (const [sessionId, entry] of [...this.watched]) {
            if (!this.deps.session(sessionId)) {
                this.forget(sessionId)
                continue
            }
            this.readScreen(sessionId, entry)
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
            const key = JSON.stringify([info?.cliSessionId ?? null, entry.working, entry.prompt?.signature ?? null, entry.queue])
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
        await this.deps.mirror.flush(sessionId)
        if (this.blockedReason(sessionId, entry)) return
        const text = entry.queue.shift()!
        entry.sending = true
        try {
            await this.deps.type(sessionId, text)
        } catch (error) {
            // A question appeared between the check and the typing: put it back and wait.
            if ((error as { code?: string }).code === 'awaiting_input') entry.queue.unshift(text)
            else console.error('[conversation] queued send failed', sessionId, error)
        } finally {
            entry.sending = false
            this.bump(sessionId, entry)
            this.dropIfIdle(sessionId, entry)
        }
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
