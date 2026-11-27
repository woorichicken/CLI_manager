// After ovis (https://github.com/devswha/ovis, 175d24c) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/opencode.ts (opencodeDatabasePath, adaptMessage1, opencodeRecord, opencodeTurns,
// sessionMetadata1, opencodeTerminalTitle) and server/skill-invocations/opencode.ts. Only OpenCode 1.x's
// store (`session` · `message` · `part`) is read: 2.x's `session_v2` store and its background service are
// not ported (this Mac runs 1.18.15, measured 2026-11-27).
//
// OpenCode keeps every conversation of every project in one SQLite file. A prompt is a `message` row
// (`data.role` user) whose text is in its `part` rows; every model step is another `message` row (role
// assistant, with `modelID`, `tokens`, `finish`, `error`) whose `text` · `reasoning` · `tool` blocks are
// `part` rows. Rows are rewritten in place while a step streams, so the chat reads the whole session
// again when it changed — never appends.
//
// Ours, not ovis's (decided from this Mac's 1.18.15 rows, 2026-11-27): a `synthetic` text part (what
// OpenCode itself put next to a prompt — «Called the Read tool …» for an @file, «Continue if you have next
// steps …» after a compaction) is not the person's prompt; a compaction's summary step shows as a
// «compacted» marker. ovis joins every text part and drops compactions.
import { join, resolve } from 'path'
import type { ConversationMeta, ConversationPart, ConversationTurn, SkillActivity, ToolPart } from '../../shared/conversation'
import { record, toolSummary } from './records'
import { trimOutput } from './toolOutput'

type Row = Record<string, unknown>

/** A session id OpenCode makes (`ses_` and base62) — anything else is not looked up. */
export const OPENCODE_SESSION_ID = /^ses_[A-Za-z0-9]{1,64}$/
/** A cut tool output's ref: the step's message id and the block's place among the step's parts. */
export const OPENCODE_TOOL_REF = /^(msg_[A-Za-z0-9]{1,64}(?:_\d{1,12}){0,8}):(\d{1,4})$/
/** A picture's ref: the message and its place among that message's pictures. */
export const OPENCODE_IMAGE_REF = /^opencode:(msg_[A-Za-z0-9]{1,64}(?:_\d{1,12}){0,8}):(\d{1,3})$/
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** One `message` row with its `part` rows, oldest first (each part's own `data` JSON). */
export interface OpencodeMessage {
    id: string
    data: Row
    parts: Row[]
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value : null)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)
const iso = (value: unknown): string | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null)
const skillName = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\r\n<>]/.test(value) ? value : null

/**
 * The store OpenCode itself opens: `OPENCODE_DB` (relative to its data folder, or anywhere; `:memory:` keeps
 * none), else `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db` — the same on macOS (no per-platform folder).
 */
export function opencodeDatabasePath(env: Record<string, string | undefined>, home: string): string | null {
    const named = env.OPENCODE_DB
    if (named === ':memory:') return null
    const data = join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'opencode')
    return named ? resolve(data, named) : join(data, 'opencode.db')
}

/**
 * The terminal title OpenCode's TUI sets on a session with this title: `OC | <title>`, cut to 40 characters
 * with an ellipsis. An untitled session (and the home screen) is plain `OpenCode`: it names no session.
 */
export function opencodeTerminalTitle(title: string): string {
    return `OC | ${title.length > 40 ? `${title.slice(0, 37)}…` : title}`
}

/** The start of the titles a terminal title may stand for (the shown title, or the part kept by a cut), or null. */
export function opencodeTitleStart(terminalTitle: string): string | null {
    if (!terminalTitle.startsWith('OC | ')) return null
    const start = terminalTitle.slice('OC | '.length).replace(/…$/, '')
    return start === '' ? null : start
}

/** A prompt a skill expanded, collapsed back to what was typed (`/<name> <args>`), recorded on OpenCode 1.17.15. */
export function opencodeSkillInvocation(prompt: string): string {
    const match = /^[\s\S]*\n\nBase directory for this skill: ([^\r\n]+)\r?\nRelative paths in this skill \(e\.g\., scripts\/, references\/\) are relative to this base directory\.\r?\n\r?\n([\s\S]*)$/.exec(prompt)
    if (!match) return prompt
    const name = match[1]?.replace(/\\/g, '/').split('/').at(-1)
    if (!name || name.length > 64 || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return prompt
    const args = match[2] ?? ''
    return `/${name}${args ? ` ${args}` : ''}`
}

/** A picture a `file` block or attachment carries as a data: URL. */
function inlineImage(file: Row): { media_type: string; data: string } | null {
    const url = typeof file.url === 'string' ? /^data:([^;,]+);base64,(.+)$/s.exec(file.url) : null
    const mediaType = typeof file.mime === 'string' ? file.mime : url?.[1]
    if (!url || typeof mediaType !== 'string' || !IMAGE_TYPES.has(mediaType) || url[2].length === 0) return null
    return { media_type: mediaType, data: url[2] }
}

/** The pictures of a message, in the order its refs count them: a prompt's `file` parts, a step's tool attachments. */
export function opencodeImages(message: OpencodeMessage): { media_type: string; data: string }[] {
    const found: { media_type: string; data: string }[] = []
    for (const part of message.parts) {
        if (message.data.role === 'user' && part.type === 'file') {
            const image = inlineImage(part)
            if (image) found.push(image)
        } else if (message.data.role === 'assistant' && part.type === 'tool') {
            for (const value of Array.isArray(record(part.state).attachments) ? (record(part.state).attachments as unknown[]) : []) {
                const item = record(value)
                const image = item.type === 'file' ? inlineImage(item) : null
                if (image) found.push(image)
            }
        }
    }
    return found
}

/** A call's state as the chat's outcome: not answered yet, answered, failed (1.x `pending`/`running` · `completed` · `error`). */
function toolState(status: unknown): ToolPart['state'] {
    return status === 'pending' || status === 'running' ? 'pending' : status === 'completed' ? 'ok' : status === 'error' ? 'error' : undefined
}

/** OpenCode's `skill` tool names the skill it loads by `name` (2.x: `id`). */
function toolSkill(name: string, input: Row, status: unknown): SkillActivity | null {
    if (name !== 'skill') return null
    const skill = skillName(input.name) ?? skillName(input.id)
    if (skill === null) return null
    return { name: skill, evidence: 'invocation', status: status === 'completed' ? 'loaded' : status === 'error' ? 'failed' : 'requested' }
}

/** What a tool printed: its output, else its metadata's (1.x keeps a running command's there); a failed call's error. */
export function opencodeToolText(part: Row): string {
    const state = record(part.state)
    if (state.status === 'error') return typeof state.error === 'string' ? state.error : text(record(state.error).message) ?? ''
    if (typeof state.output === 'string' && state.output.length > 0) return state.output
    const printed = record(state.metadata).output
    return typeof printed === 'string' ? printed : ''
}

/** A prompt's parts: its pictures, then what was typed (synthetic parts left out), a skill collapsed back. */
function userParts(message: OpencodeMessage): ConversationPart[] {
    const images = opencodeImages(message).map((image, index): ConversationPart => ({ kind: 'image', media_type: image.media_type, ref: `opencode:${message.id}:${index}` }))
    const typed = message.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string' && part.synthetic !== true)
        .map((part) => part.text as string)
        .join('\n')
    const prompt = typed.trim() ? opencodeSkillInvocation(typed) : null
    return [...images, ...(prompt === null ? [] : [{ kind: 'text' as const, text: prompt }])]
}

/** A step's parts: thinking, text and tool calls in their order; its error, unless Esc interrupted it. */
function stepParts(message: OpencodeMessage): ConversationPart[] {
    const parts: ConversationPart[] = []
    let image = 0
    message.parts.forEach((block, index) => {
        if (block.type === 'text' && text(block.text) !== null) parts.push({ kind: 'text', text: block.text as string })
        else if (block.type === 'reasoning' && text(block.text) !== null) parts.push({ kind: 'thinking', text: block.text as string })
        else if (block.type === 'tool' && typeof block.tool === 'string') {
            const state = record(block.state)
            const input = record(state.input)
            const skill = toolSkill(block.tool, input, state.status)
            const summary = toolSummary(block.tool, input)
            const part: ToolPart = {
                kind: 'tool',
                name: block.tool,
                summary: skill?.name ?? (summary === block.tool && typeof input.query === 'string' ? input.query.slice(0, 120) : summary),
                input: JSON.stringify(input, null, 2),
                output: ''
            }
            if (skill !== null) part.skill = skill
            const outcome = toolState(state.status)
            if (outcome !== undefined) part.state = outcome
            trimOutput(part, opencodeToolText(block), `${message.id}:${index}`)
            const exit = record(state.metadata).exit
            if (state.status === 'error' || (typeof exit === 'number' && exit !== 0)) part.error = true
            const attached = (Array.isArray(state.attachments) ? state.attachments : []).map(record).filter((item) => item.type === 'file' && inlineImage(item) !== null)
            if (attached.length > 0) part.images = attached.map((item) => ({ media_type: inlineImage(item)!.media_type, ref: `opencode:${message.id}:${image++}` }))
            parts.push(part)
        }
    })
    const error = record(message.data.error)
    const name = typeof error.name === 'string' ? error.name : ''
    const said = text(record(error.data).message) ?? text(error.message)
    // Esc ends a step as `MessageAbortedError`: the TUI says it was interrupted, not that anything failed
    if (!/abort/i.test(name) && said !== null) parts.push({ kind: 'text', text: `Error: ${said}` })
    return parts
}

/**
 * The session's messages as chat turns, up to `end` (a /undo hides the rows from its message on).
 * Consecutive steps merge into one answer; a step that finished with `stop` is the turn's answer, and
 * its last text is the final answer.
 */
export function opencodeTurns(messages: readonly OpencodeMessage[], end = messages.length): ConversationTurn[] {
    const turns: ConversationTurn[] = []
    let settled = false
    for (const message of messages.slice(0, end)) {
        const time = record(message.data.time)
        if (message.data.role === 'user') {
            // a compaction's trigger: OpenCode asked itself for the summary the next step holds
            if (message.parts.some((part) => part.type === 'compaction')) continue
            const parts = userParts(message)
            if (parts.length > 0) turns.push({ role: 'user', ts: iso(time.created), parts })
            settled = false
            continue
        }
        if (message.data.role !== 'assistant') continue
        if (message.data.summary === true) {
            const summary = message.parts.filter((part) => part.type === 'text' && typeof part.text === 'string').map((part) => part.text as string).join('\n')
            if (summary.trim()) turns.push({ role: 'user', ts: iso(time.created), parts: [{ kind: 'compact', text: summary }] })
            settled = true
            continue
        }
        const stop = message.data.finish === 'stop'
        const parts = stepParts(message)
        let turn = turns.at(-1)
        if (turn === undefined || turn.role !== 'assistant' || settled) {
            turn = { role: 'assistant', ts: iso(time.created), parts: [] }
            turns.push(turn)
        }
        turn.parts.push(...parts.map((part, index) => (stop && index === parts.length - 1 && part.kind === 'text' ? { ...part, phase: 'final_answer' as const } : part)))
        const finished = iso(time.completed) ?? iso(time.created)
        if (finished !== null) turn.end_ts = finished
        settled = stop
    }
    return turns.filter((turn) => turn.parts.length > 0)
}

/** The model the newest step names, and its usage as the context filled (OpenCode records no window, no effort). */
export function opencodeMeta(messages: readonly OpencodeMessage[], end = messages.length): ConversationMeta | null {
    let model: string | null = null
    let usage: Row | null = null
    for (let index = end - 1; index >= 0; index--) {
        const data = messages[index].data
        if (data.role !== 'assistant' || data.summary === true) continue
        if (model === null) model = text(data.modelID)
        if (usage === null && data.tokens !== undefined) usage = record(data.tokens)
        if (model !== null && usage !== null) break
    }
    if (model === null && usage === null) return null
    const meta: ConversationMeta = { model, effort: null }
    if (usage !== null) {
        const cache = record(usage.cache)
        const used = count(usage.input) + count(usage.output) + count(usage.reasoning) + count(cache.read) + count(cache.write)
        if (used > 0) meta.context = { used, window: null }
    }
    return meta
}
