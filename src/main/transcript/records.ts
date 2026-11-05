// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/transcript-records.ts — the rules the Claude parser shares. The pi/omp/gjc readers
// (piMessage, omoTaskResults, createOmpTranscriptParser …) are not ported: CLI Manager runs Claude Code
// and Codex only.
import type { ConversationPart, ConversationTurn, TaskResult } from '../../shared/conversation'
import type { SubagentDetail, TaskNotification } from './subagents'

type Row = Record<string, unknown>
export const record = (value: unknown): Row =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Row) : {}

export function isContextClear(value: unknown, source: string): boolean {
    const entry = record(value)
    if (source !== 'claude-transcript') return false
    const message = record(entry.message)
    if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || message.role !== 'user' || typeof message.content !== 'string') return false
    // Require a whole local-command envelope; quoting /clear in prose is not a reset.
    return /^\s*<command-name>\s*\/clear\s*<\/command-name>(?:\s*<command-message>clear<\/command-message>)?(?:\s*<command-args>\s*<\/command-args>)?\s*$/.test(message.content)
}

/**
 * Another Claude session's message (Claude Code cross-session messaging). It starts the agent's
 * work like a prompt, but nobody typed it here: a notice, sourced `peer:<sender>`.
 */
export function claudePeerNotice(value: unknown): Extract<ConversationPart, { kind: 'notice' }> | null {
    const entry = record(value)
    const queued = entry.type === 'attachment' ? record(entry.attachment) : null
    if (queued !== null && queued.type !== 'queued_command') return null
    if (queued === null && !(entry.type === 'user' && entry.isMeta === true)) return null
    const origin = record(queued !== null ? queued.origin : entry.origin)
    if (origin.kind !== 'peer') return null
    const envelope = queued !== null ? queued.prompt : record(entry.message).content
    const parsed = typeof envelope === 'string' ? /<cross-session-message\b([^>]*)>\n?([\s\S]*?)\n?<\/cross-session-message>/.exec(envelope) : null
    const body = typeof origin.body === 'string' ? origin.body : parsed?.[2] ?? ''
    const name = typeof origin.name === 'string' && origin.name.trim() ? origin.name.trim() : /\bfrom-name="([^"]+)"/.exec(parsed?.[1] ?? '')?.[1] ?? ''
    return body.trim() ? { kind: 'notice', text: body, source: `peer:${name}` } : null
}

/** One delivery of another session's message: the sender and its message id. */
export function claudePeerId(value: unknown): string | null {
    const entry = record(value)
    const queued = entry.type === 'attachment' ? record(entry.attachment) : null
    const origin = record(queued !== null ? queued.origin : entry.origin)
    return origin.kind === 'peer' && typeof origin.from === 'string' && typeof origin.msg_id === 'string' && origin.from && origin.msg_id
        ? `${origin.from}|${origin.msg_id}`
        : null
}

/** Enough turns for a conversation. */
export const MAX_TURNS = 100

export const OMO_TASK_RESULT_MAX = 16_000
const label = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null)

/** The card for a Claude Code subagent that ended, from its `<task-notification>`. */
export function agentTaskResult(notice: TaskNotification, detail: SubagentDetail | undefined): TaskResult {
    const result = notice.result
    return {
        id: notice.taskId,
        title: detail?.title ?? /^Agent "(.*)"/.exec(notice.summary)?.[1]?.trim() ?? notice.taskId,
        agent: detail?.agent ?? null,
        model: null,
        status: notice.status,
        duration_ms: null,
        turns: null,
        tool_calls: null,
        tokens: null,
        result: result.slice(0, OMO_TASK_RESULT_MAX),
        ...(result.length > OMO_TASK_RESULT_MAX ? { result_cut: true } : {})
    }
}

/** The one-line summary a collapsed tool chip shows. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
    if (name === 'task') {
        const items = Array.isArray(input['tasks']) ? input['tasks'].map(record) : [input]
        const titles = items.map((item) => label(item['task_summary']) ?? label(item['description'])).filter((title) => title !== null)
        if (titles.length > 0) return titles.join(' · ').slice(0, 120)
    }
    // what the agent itself said the call is for: the `description` Claude gives a Bash command or
    // a subagent's prompt. Another tool's `description` is its own data.
    const said = typeof input['code'] === 'string' ? label(input['summary'])
        : typeof input['command'] === 'string' || typeof input['prompt'] === 'string' ? label(input['description']) : null
    if (said !== null) return said.slice(0, 120)
    const first = input['command'] ?? input['file_path'] ?? input['notebook_path'] ?? input['path'] ?? input['pattern'] ?? input['description'] ?? input['url']
    return typeof first === 'string' ? first.slice(0, 120) : name
}

/** Complete-record folds with detached, non-committing previews of a final JSONL tail. */
export interface TranscriptParser {
    write(text: string): void
    snapshot(tail?: string): ConversationTurn[]
}
