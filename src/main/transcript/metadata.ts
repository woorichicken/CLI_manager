// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/conversation-metadata.ts — the Claude Code and Codex readers only (Copilot, Grok, Muse,
// pi/omp/omo/gjc/cmd and Agy/Letta left out). `CLAUDE_FAMILY`/`VERSION` from server/start-screen.ts.
// Folds line by line (`foldMetadata`) instead of re-reading a whole text, so TranscriptReader can feed it
// the lines it already reads for the turns.
import type { ConversationMeta } from '../../shared/conversation'
import { isContextClear } from './records'
import { localCommandStdout } from './claudeTranscript'

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {})
const label = (value: unknown): string | null => (typeof value === 'string' && value.trim() && !value.startsWith('<') ? value.trim() : null)
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

const CLAUDE_FAMILY = 'opus|sonnet|haiku|fable|mythos'
const VERSION = '[1-9]\\d?'

/** Claude's standard window; a request past it can only have run in the 1M one. */
const CLAUDE_STANDARD_WINDOW = 200_000
const CLAUDE_LONG_WINDOW = 1_000_000

/** A line longer than this is a picture or a big tool result: it names no model, and is not parsed for one. */
const MAX_META_LINE = 2 * 1024 * 1024

/**
 * The context a request filled, and the window when the transcript leaves no doubt. Only Codex
 * records its window; a Claude model is known to run in the 1M one once a request went past 200k
 * (and keeps it: a compaction shrinks the use, not the window). Otherwise no window — no ring is
 * drawn on a guess.
 */
function contextOf(used: number, model: string | null, window: number | null, before: ConversationMeta['context']): ConversationMeta['context'] {
    if (used === 0) return before
    if (window !== null) return { used, window }
    const long = model?.startsWith('claude') && (used > CLAUDE_STANDARD_WINDOW || before?.window === CLAUDE_LONG_WINDOW)
    return { used, window: long ? CLAUDE_LONG_WINDOW : null }
}

// Claude Code's /model answer names the model by its display name: in backticks (2.1.3xx), or bare
// before "and saved" / "for this session" in older versions
const CLAUDE_MODEL_SET = /^Set model to (?:`([^`]+)`|(.+?)(?= and saved | for this session|$))/u
// only the plain "<Family> <major>[.<minor>]" maps back to an id
const CLAUDE_MODEL_NAME = new RegExp(`^(${CLAUDE_FAMILY}) (${VERSION})(?:\\.(0|${VERSION}))?(?: \\(1M context\\))?(?: \\(default\\))?$`, 'iu')
const CLAUDE_EFFORT = '(low|medium|high|xhigh|max)'
const CLAUDE_EFFORT_SET = new RegExp(`^Set effort level to ${CLAUDE_EFFORT}(?= |$)`, 'u')
const CLAUDE_MODEL_EFFORT = new RegExp(` with \`${CLAUDE_EFFORT}\` effort$`, 'u')

/**
 * What a Claude Code /model or /effort answer set, so the chip follows it before the next answer
 * names it. Only the command's own record counts: a `local_command` entry, or a user entry that is
 * the whole output and was not typed.
 */
function claudeCommandSetting(entry: RecordValue): { model: string | null; effort: string | null } {
    const none = { model: null, effort: null }
    if (entry.isSidechain === true) return none
    const local = entry.type === 'system' && entry.subtype === 'local_command'
    const answer = entry.type === 'user' && entry.isMeta !== true && !('origin' in entry) && !('permissionMode' in entry)
    if (!local && !answer) return none
    const said = localCommandStdout(local ? entry.content : record(entry.message).content)?.split('\n')[0]
    if (!said) return none
    const command = label(record(entry.commandRun).command)
    const set = CLAUDE_MODEL_SET.exec(said)
    if (set && (command === null || command === 'model')) {
        const name = CLAUDE_MODEL_NAME.exec(set[1] ?? set[2] ?? '')
        if (!name) return none
        return {
            model: `claude-${name[1]!.toLowerCase()}-${name[2]}${name[3] === undefined ? '' : `-${name[3]}`}`,
            effort: CLAUDE_MODEL_EFFORT.exec(said)?.[1] ?? null
        }
    }
    const effort = CLAUDE_EFFORT_SET.exec(said)
    return effort && (command === null || command === 'effort') ? { model: null, effort: effort[1]! } : none
}

/** Claude Code's `permissionMode` values in the chat's words; `default` says nothing (no chip). */
const CLAUDE_MODES: Record<string, string | null> = { default: null, bypassPermissions: 'bypass', acceptEdits: 'accept edits', plan: 'plan', auto: 'auto', dontAsk: "don't ask" }

/** Codex's mode: a collaboration mode other than default, else how far its sandbox reaches. */
function codexMode(event: RecordValue): string | null | undefined {
    const collaboration = label(record(event.collaboration_mode).mode)
    if (collaboration && collaboration !== 'default') return collaboration
    const sandbox = label(record(event.sandbox_policy).type)
    if (!sandbox) return undefined
    return sandbox === 'danger-full-access' ? 'full access' : sandbox.replace(/-/g, ' ')
}

function claudeSetting(entry: RecordValue): { model?: string; effort?: string | null } {
    const set: { model?: string; effort?: string | null } = {}
    const model = entry.type === 'assistant' ? label(record(entry.message).model) : null
    if (model) set.model = model
    if (entry.type === 'assistant' && 'effort' in entry) set.effort = label(entry.effort)
    const command = claudeCommandSetting(entry)
    if (command.model) set.model = command.model
    if (command.effort) set.effort = command.effort
    return set
}

/** Lines that cannot name a model, skipped before JSON.parse (a busy transcript is mostly these). */
function mayNameMeta(line: string, agent: 'claude' | 'codex'): boolean {
    if (line.length === 0 || line.length > MAX_META_LINE) return false
    if (agent === 'codex') return line.includes('"turn_context"') || line.includes('"token_count"') || line.includes('"session_meta"')
    return line.includes('"assistant"') || line.includes('"permissionMode"') || line.includes('local-command') || line.includes('local_command') || line.includes('/clear')
}

/**
 * The meta after `text` (complete jsonl lines), from what it was before. Recorded settings only —
 * effort is never guessed from thinking text. Codex turn_context is a snapshot.
 */
export function foldMetadata(text: string, agent: 'claude' | 'codex', before: ConversationMeta | null): ConversationMeta | null {
    let meta: ConversationMeta | null = before ? { ...before } : null
    const ensure = (): ConversationMeta => (meta ??= { model: null, effort: null })
    for (const line of text.split('\n')) {
        if (!mayNameMeta(line, agent)) continue
        let entry: RecordValue
        try {
            entry = record(JSON.parse(line))
        } catch {
            continue
        }
        if (agent === 'claude') {
            if (isContextClear(entry, 'claude-transcript')) {
                if (meta) {
                    meta.model = null
                    meta.effort = null
                    delete meta.context
                }
                continue
            }
            // each prompt records it; a subagent's own mode is not this session's
            if (entry.type === 'user' && entry.isSidechain !== true && typeof entry.permissionMode === 'string') {
                ensure().mode = entry.permissionMode in CLAUDE_MODES ? CLAUDE_MODES[entry.permissionMode] : entry.permissionMode
            }
            const set = claudeSetting(entry)
            if (set.model !== undefined) ensure().model = set.model
            if (set.effort !== undefined) ensure().effort = set.effort
            const message = record(entry.message)
            // a subagent's request fills its own context, not this one's
            if (entry.type === 'assistant' && entry.isSidechain !== true && label(message.model)) {
                const usage = record(message.usage)
                const current = ensure()
                current.context = contextOf(
                    count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
                    current.model,
                    null,
                    current.context
                )
                if (current.context === undefined) delete current.context
            }
            continue
        }
        const event = record(entry.payload)
        if (entry.type === 'event_msg' && event.type === 'token_count') {
            const info = record(event.info)
            const window = count(info.model_context_window)
            const current = ensure()
            current.context = contextOf(count(record(info.last_token_usage).total_tokens), current.model, window || null, current.context)
            if (current.context === undefined) delete current.context
            continue
        }
        if (entry.type !== 'turn_context' && entry.type !== 'session_meta') continue
        const settings = record(record(event.collaboration_mode).settings)
        const model = label(event.model) ?? label(settings.model)
        const effort = 'effort' in event ? event.effort : 'reasoning_effort' in event ? event.reasoning_effort : settings.reasoning_effort
        if (model) ensure().model = model
        if (model || effort !== undefined) ensure().effort = label(effort)
        const mode = codexMode(event)
        if (mode !== undefined) ensure().mode = mode
    }
    return meta
}
