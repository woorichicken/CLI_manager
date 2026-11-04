import { createHash } from 'crypto'
import type { ConversationAgent, PromptAnswer, PromptKind, PromptMenu, PromptOption } from '../shared/conversation'
import { INPUT_BOX_RULE } from './screenLines'

/**
 * Reading an agent's question menu off its screen, for the Chat view's card.
 * Pure functions over rows of text (no pty), so they are tested on copies of
 * real screens. The one place in the app that reads a menu's options — the
 * desktop card and a phone page answer through it.
 *
 * Checked against real Claude Code 2.1.312 screens (permission prompt and
 * AskUserQuestion, fb-1029b evidence) and the folder-trust dialog the startup
 * watcher already answers (unnumbered options). Ideas from ovis
 * `server/dialogs/claude.ts` and `server/prompt.ts` (MIT): arrows from the
 * highlighted option then Enter, "Type something." takes the user's words, and
 * the menu must still be on screen, unchanged, right before keys are sent.
 *
 * Codex menus are read for display only (`answerable: false`): there is no copy
 * of a real Codex approval screen to check a layout against, and a wrong guess
 * would press Enter on the wrong option.
 */

/** A turn in progress: a real question replaces the spinner (checked on 2.1.312). */
const BUSY = /esc to interrupt/i

/** The footers and phrases of a menu waiting on the user. */
const MENU_MARKERS = [
    /Enter to confirm/i,
    /Enter to select/i,
    /Esc to cancel/i,
    /trust this folder/i,
    /Do you trust the contents of this directory/i,
    /Press enter to continue/i,
    /Do you want to (proceed|make|create|allow|run)/i,
    /Would you like to (run|make|apply)/i
]

/** Footer rows: hints about keys, not part of the question. */
const FOOTER = /(Enter to (confirm|select)|Esc to cancel|to navigate|Tab to amend|Press enter to continue)/i

/** How many non-blank rows at the bottom a menu can take. */
const MENU_REGION_LINES = 30

/** "❯ 1. Yes", "› 2. No", "  3. Type something." */
const NUMBERED_OPTION = /^([❯›>])?\s*(\d{1,2})\.\s+(.+?)\s*$/

/** Rules and dashed separators a dialog draws between its parts. */
const SEPARATOR = /^[─━╌┄┈-]{6,}$/

const BOX_BORDER = /[│┃╭╮╰╯┌┐└┘]/g

/** Checkbox marks of a multiple-choice question. */
const CHECKBOX = /^(\[[ x✔✓]\]|[☐☑☒◯◉●○])\s/i

const CUSTOM_OPTION = /^Type something\.?$/i

const QUESTION_MAX = 300
const CONTEXT_MAX_LINES = 6

function clean(line: string): string {
    return line.replace(BOX_BORDER, ' ').replace(/\s+$/, '')
}

/** With the agent's input box on screen, only the rows under it count (the footer). */
function belowInputBox(screen: string[]): string[] {
    const rules: number[] = []
    for (let row = screen.length - 1; row >= 0 && rules.length < 2; row--) {
        if (INPUT_BOX_RULE.test(screen[row].trim())) rules.push(row)
    }
    if (rules.length < 2) return screen
    const [bottom, top] = rules
    const first = screen.slice(top + 1, bottom).find((line) => line.trim() !== '')
    // An AskUserQuestion draws rules around its options too; a prompt line (❯ without a number) is the input box.
    return first !== undefined && /^[❯>](?!\s*\d+\.\s)/.test(first.trim()) ? screen.slice(bottom + 1) : screen
}

function kindOf(text: string, options: PromptOption[]): PromptKind {
    if (/trust this folder|Do you trust the contents of this directory/i.test(text)) return 'trust'
    if (options.some((option) => option.custom) || /Enter to select/i.test(text)) return 'question'
    if (/Do you want to|Would you like to|Tab to amend/i.test(text)) return 'permission'
    return 'menu'
}

/**
 * The menu on screen, or null when none is. `screen` is the visible rows,
 * top to bottom (TerminalMirror.screen).
 */
export function readPrompt(screen: string[], agent: ConversationAgent): PromptMenu | null {
    if (screen.some((line) => BUSY.test(line))) return null
    const rows = belowInputBox(screen)
        .map(clean)
        .filter((line) => line.trim() !== '')
        .slice(-MENU_REGION_LINES)
    const text = rows.join('\n')
    if (!MENU_MARKERS.some((marker) => marker.test(text))) return null

    // Numbered options, with the indented rows under each as its description.
    const options: PromptOption[] = []
    let firstOptionRow = -1
    let lastOptionRow = -1
    for (let row = 0; row < rows.length; row++) {
        const line = rows[row]
        const trimmed = line.trim()
        const match = NUMBERED_OPTION.exec(trimmed)
        if (match) {
            // A list that starts again (the agent's own numbered answer above the dialog): the last one is the menu.
            if (options.length > 0 && Number(match[2]) <= (options[options.length - 1].number ?? 0)) {
                options.length = 0
                firstOptionRow = -1
            }
            const label = match[3].trim()
            if (firstOptionRow < 0) firstOptionRow = row
            lastOptionRow = row
            options.push({
                index: options.length,
                number: Number(match[2]),
                label,
                selected: match[1] !== undefined,
                ...(CUSTOM_OPTION.test(label) ? { custom: true } : {})
            })
            continue
        }
        if (options.length === 0 || FOOTER.test(trimmed) || SEPARATOR.test(trimmed)) continue
        // A description is indented deeper than its option's number.
        const indent = line.length - line.trimStart().length
        if (row === lastOptionRow + 1 && indent >= 4) {
            const last = options[options.length - 1]
            last.description = last.description ? `${last.description} ${trimmed}` : trimmed
            lastOptionRow = row
        }
    }

    // A folder-trust dialog lists its two options without numbers ("❯ No, exit").
    if (options.length === 0 && /trust this folder/i.test(text)) {
        const footer = rows.findIndex((line) => FOOTER.test(line))
        const questionRow = rows.findIndex((line) => /[?？]\s*$/.test(line.trim()))
        for (let row = questionRow + 1; row < (footer < 0 ? rows.length : footer); row++) {
            const trimmed = rows[row].trim()
            if (!trimmed || SEPARATOR.test(trimmed)) continue
            const selected = /^[❯›>]/.test(trimmed)
            options.push({ index: options.length, number: null, label: trimmed.replace(/^[❯›>]\s*/, ''), selected })
            if (firstOptionRow < 0) firstOptionRow = row
        }
    }

    const above = firstOptionRow >= 0 ? rows.slice(0, firstOptionRow) : rows
    const questionAt = (() => {
        for (let row = above.length - 1; row >= 0; row--) if (/[?？]\s*$/.test(above[row].trim())) return row
        for (let row = above.length - 1; row >= 0; row--) if (MENU_MARKERS.some((marker) => marker.test(above[row]))) return row
        return -1
    })()
    const questionLine = questionAt >= 0 ? above[questionAt].trim() : rows.find((line) => MENU_MARKERS.some((m) => m.test(line)))?.trim() ?? ''
    const question = questionLine.length > QUESTION_MAX ? `${questionLine.slice(0, QUESTION_MAX - 1)}…` : questionLine

    // The rows between the dialog's top edge (a full rule, or the prompt above it) and the question:
    // the command, the tab title. Dashed rules inside the dialog are skipped, not edges.
    let top = questionAt - 1
    while (top >= 0 && !INPUT_BOX_RULE.test(above[top].trim()) && !/^[❯>⏺●⎿]/.test(above[top].trim()) && questionAt - top <= CONTEXT_MAX_LINES * 2) top--
    // No edge found (Codex draws none): the rows above are the agent's output, not the dialog's.
    const edgeFound = top >= 0 && questionAt - top <= CONTEXT_MAX_LINES * 2
    const context = (questionAt > 0 && edgeFound ? above.slice(top + 1, questionAt) : [])
        .map((line) => line.trim())
        .filter((line) => line && !SEPARATOR.test(line) && !/^Tip:/i.test(line))
        .slice(-CONTEXT_MAX_LINES)

    const multi = options.some((option) => CHECKBOX.test(option.label))
    const kind = kindOf(text, options)
    const answerable = agent === 'claude' && options.length > 0 && !multi && options.some((option) => option.selected)
    const selected = options.findIndex((option) => option.selected)
    // A hash, not the words: the card goes to a phone with its words masked (maskSnapshot), and a plain
    // JSON signature carried the unmasked command — a key in it — right beside them (ovis dialogs/shared.ts:331)
    const signature = createHash('sha256')
        .update(JSON.stringify([agent, kind, question, context, options.map((option) => option.label), selected]))
        .digest('hex')
    return { agent, kind, question, context, options, multi, answerable, signature }
}

export const KEYS = {
    up: '\x1b[A',
    down: '\x1b[B',
    enter: '\r'
} as const

/** One step of an answer: a key, or text typed as it is. */
export type AnswerStep = { key: string } | { text: string }

export class PromptAnswerError extends Error {}

/**
 * The keys that give `answer` to `menu`: arrows from the highlighted option to
 * the chosen one, then Enter. "Type something." takes the words typed into its
 * row, then Enter (no Enter before — the row is already the text field).
 */
export function answerSteps(menu: PromptMenu, answer: PromptAnswer): AnswerStep[] {
    if (!menu.answerable) throw new PromptAnswerError('Answer this question in the terminal.')
    const from = menu.options.findIndex((option) => option.selected)
    if (from < 0) throw new PromptAnswerError('No option is highlighted on screen.')
    const move = (to: number): AnswerStep[] => {
        const steps: AnswerStep[] = []
        const key = to > from ? KEYS.down : KEYS.up
        for (let i = 0; i < Math.abs(to - from); i++) steps.push({ key })
        return steps
    }
    if ('customText' in answer) {
        const custom = menu.options.find((option) => option.custom)
        const text = answer.customText.replace(/\s+/g, ' ').trim()
        if (!custom) throw new PromptAnswerError('This question takes no typed answer.')
        if (!text) throw new PromptAnswerError('Type an answer first.')
        return [...move(custom.index), { text }, { key: KEYS.enter }]
    }
    const target = menu.options[answer.optionIndex]
    if (!target) throw new PromptAnswerError('That option is not on screen.')
    if (target.custom) throw new PromptAnswerError('Type the answer for this option.')
    return [...move(target.index), { key: KEYS.enter }]
}
