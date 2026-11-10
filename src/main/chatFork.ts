import type { ChatForkScope, ConversationAgent, ConversationTurn } from '../shared/conversation'
import { decideAgentCommand, type AliasResolver } from '../shared/agentCommand'
// the chat's own reading of a reply (pure): the excerpt carries what Copy answer copies
import { turnSegments } from '../renderer/src/components/ChatView/workBlocks'
import { maskSecretLines } from './maskSecrets'

/**
 * «Fork into a new session» (Chat view): the pure part — the new session's name, its start command,
 * and the first message it gets. ConversationService.fork checks the reply and hands these to
 * ControlApiService.openFork, which opens the session.
 *
 * The first message is never part of the start command. It is typed into the agent once it is up,
 * the way the Control API types a first prompt (bracketed paste, Enter checked): a command line would
 * need shell quoting for the person's words, and a long excerpt typed before the shell's line editor
 * starts would hit the terminal's line limit.
 */

export const FORK_NAME_SUFFIX = ' · fork'
/** The excerpt's turns, newest kept: the reply, and the turns before it up to this many in all. */
export const EXCERPT_MAX_TURNS = 6
/** One turn's words in the excerpt (the start is kept: an answer's point is usually up front). */
export const EXCERPT_TURN_MAX_CHARS = 4_000
/** The excerpt's turns together; the oldest are left out first. */
export const EXCERPT_MAX_CHARS = 12_000
/** «Quote this reply», at most. */
export const QUOTE_MAX_CHARS = EXCERPT_TURN_MAX_CHARS

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const AGENT_NAMES: Record<ConversationAgent, string> = { claude: 'Claude', codex: 'Codex' }
const CUT_MARK = ' … (cut)'

/** «<name> · fork», the name cut first so the mark always shows. */
export function forkSessionName(name: string, maxLength = 80): string {
    const base = name.trim() || 'Session'
    const room = Math.max(1, maxLength - FORK_NAME_SUFFIX.length)
    return (base.length > room ? base.slice(0, room).trimEnd() : base) + FORK_NAME_SUFFIX
}

/**
 * The person's own start command for `agent`, as the agentCommand.ts rules keep it: an alias, its
 * options and a preparation before it survive, an old resume target (or a prompt) does not — on any
 * doubt, the agent's name alone. `stored` is what the new session keeps for its own restart.
 */
export function forkBaseCommand(agent: ConversationAgent, savedCommand: string | undefined, resolveAlias?: AliasResolver): { input: string; stored: string } {
    const decision = decideAgentCommand(savedCommand, agent, resolveAlias)
    return { input: decision.inputCommand, stored: decision.confident ? decision.storedCommand.trim() : decision.inputCommand }
}

/** Whole: the agent's own fork of conversation `id` — Claude `--resume <id> --fork-session`, Codex `fork <id>`. */
export function forkCommand(agent: ConversationAgent, savedCommand: string | undefined, id: string, resolveAlias?: AliasResolver): string {
    if (!UUID.test(id)) throw new Error('The conversation id is not a UUID.')
    const base = forkBaseCommand(agent, savedCommand, resolveAlias).input
    return agent === 'codex' ? `${base} fork ${id}` : `${base} --resume ${id} --fork-session`
}

/** A turn as words: the person's text (a picture as «[image]»), or the agent's final answer — not its work. */
export function turnWords(turn: ConversationTurn): string {
    if (turn.role === 'user') {
        return turn.parts
            .flatMap((part) => (part.kind === 'text' ? [part.text] : part.kind === 'image' ? ['[image]'] : []))
            .join('\n')
            .trim()
    }
    return turnSegments(turn.parts)
        .filter((segment) => segment.kind === 'answer')
        .flatMap((segment) => segment.parts.map((part) => part.text))
        .join('\n\n')
        .trim()
}

function cut(text: string, max: number): string {
    return text.length > max ? text.slice(0, max - CUT_MARK.length).trimEnd() + CUT_MARK : text
}

/** Secrets in what the turns hold are masked; a line count stays as it was. */
function mask(text: string): string {
    return maskSecretLines(text.split('\n'), { joinLines: false }).lines.join('\n')
}

export interface ForkMessageInput {
    /** every turn of the conversation, oldest first (TranscriptRead.turns) */
    turns: ConversationTurn[]
    /** the reply forked from */
    turnIndex: number
    agent: ConversationAgent
    /** the session forked from, named in the excerpt's head line */
    sourceName: string
    scope: ChatForkScope
    message: string
    quote: boolean
}

/** The excerpt's turns: the reply and those before it, newest kept, within the turn and character caps. */
function excerptBlocks(turns: ConversationTurn[], turnIndex: number, agent: ConversationAgent): string[] {
    const blocks: string[] = []
    let used = 0
    for (let index = turnIndex; index >= 0 && blocks.length < EXCERPT_MAX_TURNS; index--) {
        const turn = turns[index]
        const words = turnWords(turn)
        if (!words) continue
        const block = `### ${turn.role === 'user' ? 'Me' : AGENT_NAMES[agent]}\n${cut(words, EXCERPT_TURN_MAX_CHARS)}`
        // the reply itself always goes in; an older turn only while there is room
        if (blocks.length > 0 && used + block.length > EXCERPT_MAX_CHARS) break
        blocks.unshift(block)
        used += block.length
    }
    return blocks
}

/** What the new session's agent is sent first; '' when there is nothing to send (a bare whole fork). */
export function forkFirstMessage(input: ForkMessageInput): string {
    const words = input.message.trim()
    if (input.scope === 'excerpt') {
        const blocks = excerptBlocks(input.turns, input.turnIndex, input.agent)
        const head =
            `[Context copied from the session "${input.sourceName}": its last ${blocks.length} ${blocks.length === 1 ? 'turn' : 'turns'} ` +
            'up to the reply I branched from. An excerpt of the conversation, not a summary.]'
        const tail = words || 'That is the context. Wait for my next message.'
        return `${head}\n\n${mask(blocks.join('\n\n'))}\n\n---\n\n${tail}`
    }
    if (!input.quote) return words
    const reply = input.turns[input.turnIndex]
    const quoted = reply ? mask(cut(turnWords(reply), QUOTE_MAX_CHARS)) : ''
    if (!quoted) return words
    const block = quoted.split('\n').map((line) => (line ? `> ${line}` : '>')).join('\n')
    return words ? `About this reply of yours:\n\n${block}\n\n${words}` : `About this reply of yours:\n\n${block}`
}
