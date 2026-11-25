// After ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/agy.ts (parseAgyTranscript, agyUserText, the step ledger's supersede rule). The
// SQLite rewind catalog (`agyCatalog`) is not ported yet: a rewound step stays in the chat until the
// ledger rewrites it.
//
// Antigravity CLI (agy) writes one JSON line per step to
// `<data dir>/brain/<conversation id>/.system_generated/logs/transcript_full.jsonl` (measured on agy
// 1.5.16, 2026-11-25): `step_index`, `type` (USER_INPUT · PLANNER_RESPONSE · GENERIC · SYSTEM_MESSAGE),
// `status` (DONE · RUNNING), `created_at`, `content`; a planner response adds `model`, token counts,
// `thinking` and `tool_calls` ({ name, args }); a GENERIC step is a tool's result, with no call id.
import type { ConversationPart, ConversationTurn, ToolPart } from '../../shared/conversation'
import { record, type TranscriptParser } from './records'
import { trimOutput } from './toolOutput'

/** The ref a cut tool output is fetched back by: the GENERIC step that holds it. */
export const AGY_OUTPUT_REF = /^agy-step:(\d{1,9})$/

interface Step {
    index: number
    type: string
    status: string
    ts: string | null
    content: string
    thinking: string
    calls: { name: string; args: Record<string, unknown> }[]
}

/** A USER_INPUT step's prompt, without the request wrapper agy adds around it (ovis agyUserText). */
export function agyUserText(text: string): string {
    if (!text.startsWith('<USER_REQUEST>')) return text
    const end = text.lastIndexOf('</USER_REQUEST>')
    if (end < 0) return text
    const suffix = text.slice(end + '</USER_REQUEST>'.length)
    if (!/^\s*(?:<(?:ADDITIONAL_METADATA|USER_SETTINGS_CHANGE)>|$)/.test(suffix)) return text
    return text.slice('<USER_REQUEST>'.length, end).replace(/^\n|\n$/g, '')
}

/** A GENERIC step opens with its own timing lines (`Created At: …`, `Completed At: …`); the chat shows the result. */
export function agyResultText(content: string): string {
    return content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, '')
}

/** What a tool call is about, in one line: agy 1.5.16 names files `Path` and commands `CommandLine`. */
function callSummary(name: string, args: Record<string, unknown>): string {
    const first = [args.toolSummary, args.CommandLine, args.Path, args.AbsolutePath, args.TargetFile, args.Query, args.Url]
        .find((value) => typeof value === 'string' && value.trim() !== '')
    return (typeof first === 'string' ? first : name).slice(0, 120)
}

function stepOf(line: string): Step | null {
    let value: Record<string, unknown>
    try {
        value = record(JSON.parse(line))
    } catch {
        return null
    }
    const index = value.step_index
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || typeof value.type !== 'string') return null
    const calls = Array.isArray(value.tool_calls)
        ? value.tool_calls.map(record).filter((call) => typeof call.name === 'string').map((call) => ({ name: call.name as string, args: record(call.args) }))
        : []
    return {
        index,
        type: value.type,
        status: typeof value.status === 'string' ? value.status : '',
        ts: typeof value.created_at === 'string' ? value.created_at : null,
        content: typeof value.content === 'string' ? value.content : '',
        thinking: typeof value.thinking === 'string' ? value.thinking : '',
        calls
    }
}

function turnsOf(steps: readonly Step[]): ConversationTurn[] {
    const turns: ConversationTurn[] = []
    // tool calls waiting for their GENERIC result, oldest first: agy records no call id, and writes
    // each call's result as the next GENERIC step
    let pending: ToolPart[] = []
    // calls a later step shows will never be answered (agy wrote fewer results — 10 of 944 planner
    // responses on this Mac's ledgers, 2026-11-25): done, outcome unknown, not spinning forever, and
    // the next planner's results do not land on them
    const settle = (): void => {
        for (const tool of pending) delete tool.state
        pending = []
    }
    const assistant = (ts: string | null): ConversationTurn => {
        const last = turns.at(-1)
        if (last?.role === 'assistant') {
            if (ts) last.end_ts = ts
            return last
        }
        const turn: ConversationTurn = { role: 'assistant', ts, ...(ts ? { end_ts: ts } : {}), parts: [] }
        turns.push(turn)
        return turn
    }
    for (const step of steps) {
        if (step.type === 'USER_INPUT') {
            if (step.status !== 'DONE') continue
            const text = agyUserText(step.content)
            if (!text.trim()) continue
            settle()
            turns.push({ role: 'user', ts: step.ts, parts: [{ kind: 'text', text }] })
            continue
        }
        if (step.type === 'PLANNER_RESPONSE') {
            if (step.status !== 'DONE') continue
            const parts: ConversationPart[] = []
            if (step.calls.length > 0) settle()
            if (step.thinking.trim()) parts.push({ kind: 'thinking', text: step.thinking })
            if (step.content.trim()) parts.push({ kind: 'text', text: step.content })
            for (const call of step.calls) {
                const tool: ToolPart = { kind: 'tool', name: call.name, summary: callSummary(call.name, call.args), input: JSON.stringify(call.args, null, 2), output: '', state: 'pending' }
                parts.push(tool)
                pending.push(tool)
            }
            if (parts.length > 0) assistant(step.ts).parts.push(...parts)
            continue
        }
        if (step.type === 'GENERIC') {
            const tool = pending[0]
            if (step.status !== 'DONE') continue // still running: its call stays pending
            const output = agyResultText(step.content)
            if (tool) {
                pending.shift()
                trimOutput(tool, output, `agy-step:${step.index}`)
                delete tool.state
                const turn = turns.at(-1)
                if (turn?.role === 'assistant' && step.ts) turn.end_ts = step.ts
            } else if (output.trim()) {
                const part: ToolPart = { kind: 'tool', name: 'Tool output', summary: `Step ${step.index}`, input: '', output: '' }
                trimOutput(part, output, `agy-step:${step.index}`)
                assistant(step.ts).parts.push(part)
            }
        }
        // SYSTEM_MESSAGE: agy's own reminders to the model, not the conversation
    }
    return turns.filter((turn) => turn.parts.length > 0)
}

/**
 * The step ledger, folded as it grows. A line whose `step_index` is not past the last one replaces
 * that step and every step after it (a step rewritten, or a rewind writing the conversation again).
 */
export function createAgyTranscriptParser(): TranscriptParser {
    const steps: Step[] = []
    const write = (text: string, into: Step[]): void => {
        for (const line of text.split('\n')) {
            if (!line.trim()) continue
            const step = stepOf(line)
            if (step === null) continue
            while (into.length > 0 && into[into.length - 1].index >= step.index) into.pop()
            into.push(step)
        }
    }
    return {
        write: (text) => write(text, steps),
        snapshot(tail = ''): ConversationTurn[] {
            if (!tail.trim()) return turnsOf(steps)
            const preview = [...steps]
            write(tail, preview)
            return turnsOf(preview)
        }
    }
}

/** The model and effort the last planner response names: agy writes `gemini-3.8-flash-low`, the effort last. */
export function agyModelOf(model: string): { model: string; effort: string | null } {
    const match = /^(.+)-(low|medium|high|xhigh|max)$/.exec(model)
    return match ? { model: match[1], effort: match[2] } : { model, effort: null }
}
