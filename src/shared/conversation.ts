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

/** The model the conversation runs on, read from its own records (ovis `ConversationMetadata`). */
export interface ConversationMeta {
    /** the model id as the agent recorded it (`claude-opus-…`, `gpt-…`), or the words of a `/model` change not yet answered on */
    model: string | null
    /** reasoning effort / thinking level as recorded (Claude 2.1.3xx `effort`, Codex `turn_context.effort`); null when not recorded */
    effort: string | null
    /**
     * How much of the model's context the last request filled, in tokens. `window` is the model's
     * context size when the record says it (Codex `model_context_window`); Claude's records do not.
     */
    context?: { used: number; window: number | null }
}

/** A message sent from the chat while the agent worked, waiting for the turn to end. */
export interface QueuedMessage {
    id: string
    text: string
}

export interface ConversationSnapshot {
    sessionId: string
    /** the session's working folder: relative paths in the chat resolve against it */
    cwd?: string
    /** the home folder of the Mac running the agent: `~/` paths resolve against it */
    home?: string
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
    /** messages sent from the chat while the agent worked, waiting for the turn to end, oldest first */
    queued: QueuedMessage[]
    /** model · effort · context, from the transcript; null before the first answer records them */
    meta: ConversationMeta | null
    /** bumps on every change, so a subscriber can skip a fetch it already has */
    revision: number
}

export type ChatSendResult =
    | { status: 'sent' }
    /** the agent was working: main sends it when the turn ends */
    | { status: 'queued' }
    /**
     * `not_submitted`: typed and Enter pressed, but the text is still in the agent's input box.
     * `no_agent`: only the shell is left in the terminal (or another program took the agent's place).
     */
    | { status: 'rejected'; reason: 'awaiting_input' | 'input_busy' | 'not_running' | 'exited' | 'empty' | 'too_large' | 'unknown_session' | 'not_submitted' | 'no_agent'; message: string }

export type InterruptResult =
    | { status: 'stopped' }
    | { status: 'rejected'; reason: 'not_working' | 'not_running'; message: string }

/** What a picked or pasted file became: a path the agent can read (`@path` in the message). */
export type AttachResult =
    | { status: 'attached'; path: string }
    | { status: 'rejected'; reason: 'too_large' | 'unreadable' | 'not_running'; message: string }

/** One `/` command the session's agent offers, for the composer's completion menu. */
export interface ChatCommand {
    /** without the leading `/` (Claude `review`, `plugin:skill`; Codex `prompts:name`) */
    name: string
    description: string
    /** where it comes from, for the menu's groups */
    source: 'builtin' | 'skill' | 'command' | 'project' | 'prompt'
    /** typed with this (Codex skills: `$`); `/` when absent */
    trigger?: '$'
    /**
     * Only the terminal can show what it opens (a panel, a picker): the chat shows the terminal after
     * sending it — `always`, or only when sent `bare` (no argument).
     */
    terminal?: 'always' | 'bare'
}

/** The chat's own preferences (Settings › Terminal › Chat view), handed to the view as a prop. */
export interface ChatPreferences {
    /** Enter sends (Shift+Enter breaks the line); off: Enter breaks the line and ⌘/Ctrl+Enter sends. Default on. */
    enterSends?: boolean
    /** Show one-tap replies over the empty box. Default off, as in ovis. */
    showQuickReplies?: boolean
    /** The replies, in order. Default: continue · yes · no · retry. */
    quickReplies?: string[]
}

export const DEFAULT_QUICK_REPLIES = ['continue', 'yes', 'no', 'retry']

/** A file is attached by its path; one the app has to store first (a pasted picture) may be this big. */
export const MAX_ATTACH_BYTES = 32 * 1024 * 1024

/** The longest message the chat sends (main refuses longer). */
export const MAX_CHAT_TEXT_LENGTH = 100_000

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
    /** Drops every queued message. */
    cancelQueued(sessionId: string): Promise<void>
    /** Drops one queued message. */
    discardQueued(sessionId: string, id: string): Promise<void>
    /** Sends one queued message now, while the agent still works (the agent decides when it reads it). */
    sendQueuedNow(sessionId: string, id: string): Promise<ChatSendResult>
    /** Stops the agent's turn (Esc to its terminal) — refused unless its screen shows a turn in progress. */
    interrupt(sessionId: string): Promise<InterruptResult>
    answerPrompt(sessionId: string, answer: PromptAnswer): Promise<PromptAnswerResult>
    /** A file to mention in a message: its own path when it has one, else stored by the app first. */
    attachFile(sessionId: string, file: File): Promise<AttachResult>
    /** A picture the transcript holds (`ref` from an image part or a tool's `images`), as a data: URL. */
    getImage(sessionId: string, ref: string): Promise<string | null>
    /** The whole output of a tool whose output the chat cut (`output_ref`). */
    getToolOutput(sessionId: string, ref: string): Promise<string | null>
    /** The `/` commands the session's agent offers. */
    listCommands(sessionId: string): Promise<ChatCommand[]>
    /** Files under the session's folder whose name or path matches, as paths relative to it. */
    searchFiles(sessionId: string, query: string): Promise<string[]>
    /** Shows a file the chat names (absolute, or relative to the session's folder), at a line when given. */
    openFile(sessionId: string, path: string, line?: number): void
    /** Opens a web address outside the app. */
    openLink(url: string): void
}

/** How many turns a Chat view asks for first. */
export const CHAT_TURN_LIMIT = 200
