// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: src/lib/workBlocks.ts — splitTurn, turnSegments, workStartsOpen, workSummary, workFailed,
// formatWorkDuration, isLiveWorkTurn, endedOnAnswer. Not ported: run naming across redraws (runNames),
// todo grouping (todoGroups) and i18n — the labels are plain English like the rest of the app.
import type { ConversationPart, ConversationTurn } from '../../../../shared/conversation'

export type TextPart = Extract<ConversationPart, { kind: 'text' }>

const isProse = (part: ConversationPart): part is TextPart => part.kind === 'text' && part.text.trim().length > 0
const isAnswer = (part: ConversationPart): part is TextPart => isProse(part) && part.phase !== 'commentary'
const isWork = (part: ConversationPart): boolean => part.kind !== 'text' || (isProse(part) && part.phase === 'commentary')

/** `start`: the index of the run's first part in the turn */
export type TurnSegment =
    | { kind: 'work'; start: number; parts: ConversationPart[] }
    | { kind: 'answer'; start: number; parts: TextPart[] }

/**
 * The turn in the agent's own order, as its terminal shows it: each run of work
 * (tool calls, reasoning, progress narration) between two answers is its own
 * block, so words written before a tool call stay above it.
 */
export function turnSegments(parts: ConversationPart[]): TurnSegment[] {
    const segments: TurnSegment[] = []
    parts.forEach((part, index) => {
        const last = segments.at(-1)
        if (isAnswer(part)) {
            if (last?.kind === 'answer') last.parts.push(part)
            else segments.push({ kind: 'answer', start: index, parts: [part] })
        } else if (isWork(part)) {
            if (last?.kind === 'work') last.parts.push(part)
            else segments.push({ kind: 'work', start: index, parts: [part] })
        }
    })
    return segments
}

/**
 * A work block is open while its turn runs and folded once the turn settles —
 * unless words come after the last answer (folding would hide the newest thing
 * the agent said).
 */
export function workStartsOpen(live: boolean, parts: ConversationPart[]): boolean {
    if (live) return true
    const answers = parts.filter(isAnswer)
    const lastAnswer = answers.at(-1)
    const after = lastAnswer === undefined ? 0 : parts.lastIndexOf(lastAnswer) + 1
    return parts.slice(after).some((part) => part.kind === 'text' && part.text.trim().length > 0)
}

type WorkCategory = 'edit' | 'read' | 'command' | 'other'

const CATEGORY_LABEL: Record<WorkCategory, [string, string]> = {
    edit: ['edit', 'edits'],
    read: ['file read', 'file reads'],
    command: ['command', 'commands'],
    other: ['other tool', 'other tools']
}

function categorize(name: string): WorkCategory {
    const lower = name.toLowerCase()
    if (/edit|write|patch|create_file|multiedit/.test(lower)) return 'edit'
    if (/^(read|glob|grep|ls|list|search|find|cat)/.test(lower)) return 'read'
    if (/bash|command|shell|exec|eval|run/.test(lower)) return 'command'
    return 'other'
}

const isTodoTool = (name: string): boolean => /^(TodoWrite|update_plan|todo_?write)$/i.test(name)

/** "1 edit · 2 file reads · 1 command" — the block's header. */
export function workSummary(parts: readonly ConversationPart[]): string {
    const counts: Record<WorkCategory, number> = { edit: 0, read: 0, command: 0, other: 0 }
    let skills = 0
    for (const part of parts) {
        if (part.kind === 'skill') skills += 1
        if (part.kind !== 'tool') continue
        if (part.skill) skills += 1
        else if (!isTodoTool(part.name)) counts[categorize(part.name)] += 1
    }
    const pieces = (Object.keys(counts) as WorkCategory[])
        .filter((category) => counts[category] > 0)
        .map((category) => `${counts[category]} ${CATEGORY_LABEL[category][counts[category] === 1 ? 0 : 1]}`)
    if (skills > 0) pieces.unshift(`${skills} ${skills === 1 ? 'skill' : 'skills'}`)
    return pieces.join(' · ')
}

/** How many calls failed — said apart from the counts so a cut header never hides it. */
export function workFailed(parts: readonly ConversationPart[]): number {
    return parts.filter((part) => part.kind === 'tool' && part.error === true).length
}

/** "7s" / "1m 12s" for a block header; null when the span is unknown or nonsense. */
export function formatWorkDuration(startTs: string | null, endTs: string | null | undefined): string | null {
    if (startTs === null || endTs === null || endTs === undefined) return null
    const ms = Date.parse(endTs) - Date.parse(startTs)
    if (!Number.isFinite(ms) || ms < 0) return null
    const seconds = Math.round(ms / 1000)
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const rest = seconds % 60
    if (minutes < 60) return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** The turn's last part is its final answer: the agent ended the turn there. */
export function endedOnAnswer(turn: ConversationTurn): boolean {
    const end = turn.parts.at(-1)
    return end?.kind === 'text' && end.phase === 'final_answer'
}

/** The last assistant turn is the one running while the agent works (unless it already ended on its answer). */
export function isLiveWorkTurn(turn: ConversationTurn, last: boolean, working: boolean): boolean {
    if (working && endedOnAnswer(turn)) return false
    return last && turn.role === 'assistant' && working
}
