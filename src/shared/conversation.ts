/**
 * The Chat view's data: one conversation read from an agent's own transcript
 * file (Claude Code `~/.claude/projects/<project>/<session>.jsonl`, Codex
 * `rollout-…-<thread>.jsonl`), plus what the live screen says (working, a
 * question menu).
 *
 * Made once in main (TranscriptReader + ConversationService) and handed out as
 * plain JSON. The desktop renderer gets it over IPC; a phone page would get the
 * same JSON over HTTP. That is why the Chat view components take a
 * `ChatTransport` prop and never call `window.api` themselves.
 *
 * The turn and part shapes follow ovis `shared/protocol.ts` (MIT, see
 * THIRD_PARTY_NOTICES.md) so its parsers carry over; only the chat's share of
 * that file is here.
 */

/** Evidence of skill activity, not a claim that the skill's workflow completed. */
export interface SkillActivity {
    name: string
    evidence: 'invocation' | 'instructions'
    status: 'requested' | 'loaded' | 'failed'
    path?: string
}

/** A background task or subagent that ended, as the agent reported it back. */
export interface TaskResult {
    id: string
    title: string
    agent: string | null
    model: string | null
    status: 'completed' | 'failed' | 'cancelled'
    duration_ms: number | null
    turns: number | null
    tool_calls: number | null
    tokens: number | null
    /** at most 16,000 characters; `result_cut` when there was more */
    result: string
    result_cut?: boolean
}

export type ToolPart = {
    kind: 'tool'
    name: string
    summary: string
    input: string
    output: string
    error?: boolean
    skill?: SkillActivity
    /** set when `output` was cut: the whole output's length (the rest stays in the file) */
    output_ref?: string
    output_size?: number
    /** pictures the call returned; the chat names them, it does not fetch them */
    images?: { media_type: string; ref: string }[]
    /** the agent's own id for the call (Claude `tool_use.id`, Codex `call_id`) */
    call_id?: string
    /** Claude: `pending` until its result, then `ok`/`error`. Codex: `pending`, then absent. */
    state?: 'pending' | 'ok' | 'error'
}

export type ConversationPart =
    | { kind: 'text'; text: string; phase?: 'commentary' | 'final_answer' }
    /** the agent's reasoning; folded, shown on request */
    | { kind: 'thinking'; text: string }
    | { kind: 'skill'; skill: SkillActivity }
    | ToolPart
    /** a picture in a prompt; the first version shows a placeholder, not the bytes */
    | { kind: 'image'; media_type: string; ref: string }
    /** the summary a compaction left */
    | { kind: 'compact'; text: string }
    /** a message the runtime put in the user's seat (a slash command's answer, another session's message) */
    | { kind: 'notice'; text: string; source?: string }
    /** a `!` command the user ran without the model, and what it printed */
    | { kind: 'shell'; command: string; stdout?: string; stderr?: string }
    | { kind: 'task_result'; tasks: TaskResult[] }

export interface ConversationTurn {
    role: 'user' | 'assistant'
    ts: string | null
    /** Last recorded assistant activity, never the next user's timestamp. */
    end_ts?: string
    parts: ConversationPart[]
}

export type ConversationAgent = 'claude' | 'codex'

/** One option of a question menu read off the screen. */
export interface PromptOption {
    /** 0-based position in the menu, top to bottom */
    index: number
    /** the number the agent printed ("1."), or null for an unnumbered option */
    number: number | null
    label: string
    /** the dim line(s) under the option */
    description?: string
    /** the cursor (❯ / ›) is on this option */
    selected: boolean
    /** "Type something." — answering it types the user's own words */
    custom?: boolean
}

export type PromptKind = 'permission' | 'question' | 'trust' | 'menu'

/**
 * A question the agent is waiting on, read from the live screen (not the
 * transcript). `signature` names exactly this menu: an answer carries it back,
 * and main refuses to send keys when the screen no longer shows the same menu.
 */
export interface PromptMenu {
    agent: ConversationAgent
    kind: PromptKind
    /** the question line ("Do you want to proceed?") */
    question: string
    /** lines above the question worth showing (the command, the tab title) */
    context: string[]
    options: PromptOption[]
    /** several options can be ticked — answered in the terminal for now */
    multi: boolean
    /**
     * The card can send keys for this menu. False when the screen layout is one
     * this app has no captured copy of (Codex menus, multi-select): the card then
     * only offers "Answer in Terminal".
     */
    answerable: boolean
    signature: string
}

export interface ConversationSnapshot {
    sessionId: string
    /** which agent's transcript; null when the session has no conversation linked yet */
    agent: ConversationAgent | null
    /** why there is nothing to show (no conversation id, file not found, read failed) */
    unavailable?: 'no-conversation' | 'not-found' | 'read-failed'
    /** the last `limit` turns, oldest first */
    turns: ConversationTurn[]
    /** turns the file holds in all (after a /clear: since it) */
    totalTurns: number
    /** the file was too big to read whole: the first turns are missing */
    truncated: boolean
    /** the agent's screen shows a turn in progress */
    working: boolean
    /** a question menu on screen, or null */
    prompt: PromptMenu | null
    /** text sent from the chat while the agent worked, waiting for the turn to end */
    queued: string[]
    /** bumps on every change, so a subscriber can skip a fetch it already has */
    revision: number
}

export type ChatSendResult =
    | { status: 'sent' }
    /** the agent was working: main sends it when the turn ends */
    | { status: 'queued' }
    | { status: 'rejected'; reason: 'awaiting_input' | 'input_busy' | 'not_running' | 'exited' | 'empty' | 'too_large' | 'unknown_session'; message: string }

export type PromptAnswer =
    | { signature: string; optionIndex: number }
    | { signature: string; customText: string }

export type PromptAnswerResult =
    | { status: 'answered' }
    | { status: 'rejected'; reason: 'prompt_changed' | 'not_answerable' | 'bad_answer' | 'not_running'; message: string }

/**
 * What a Chat view needs from wherever it runs: read turns, hear about changes,
 * send a message, answer a card. Electron fills it with IPC
 * (`renderer/src/utils/electronChatTransport.ts`); a phone page would fill it
 * with fetch + WebSocket. Chat view components take it as a prop.
 */
export interface ChatTransport {
    getConversation(sessionId: string, limit?: number): Promise<ConversationSnapshot>
    /** Calls `onChange` whenever the conversation, the working state or the question changes. */
    subscribe(sessionId: string, onChange: (revision: number) => void): () => void
    send(sessionId: string, text: string): Promise<ChatSendResult>
    cancelQueued(sessionId: string): Promise<void>
    answerPrompt(sessionId: string, answer: PromptAnswer): Promise<PromptAnswerResult>
}

/** How many turns a Chat view asks for first. */
export const CHAT_TURN_LIMIT = 200
