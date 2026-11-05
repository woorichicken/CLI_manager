import { createHash } from 'crypto'
import type { ConversationAgent, PromptAnswer, PromptKind, PromptMenu, PromptOption } from '../shared/conversation'
import { isInputBoxRule } from './screenLines'

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
        if (isInputBoxRule(screen[row].trim())) rules.push(row)
    }
    if (rules.length < 2) return screen
    const [bottom, top] = rules
    const first = screen.slice(top + 1, bottom).find((line) => line.trim() !== '')
    // An AskUserQuestion draws rules around its options too; a prompt line (❯ without a number) is the input box.
    return first !== undefined && /^[❯>](?!\s*\d+\.\s)/.test(first.trim()) ? screen.slice(bottom + 1) : screen
}

/** A divider row: only rules and box corners. */
const DIVIDER = /^[\s╭╮╰╯├┤┬┴┼─━═╌▔]+$/

interface ConfirmMenu {
    options: PromptOption[]
    question: string
    context: string[]
}

/**
 * Claude Code's unnumbered menus, the folder-trust check on a new folder (2.1.285):
 *
 *   Accessing workspace:
 *   /home/user/project
 *   Quick safety check: Is this a project you created or one you trust? (Like your own code,
 *   …
 *   ❯ No, exit
 *     Yes, I trust this folder
 *   Enter to confirm · Esc to cancel
 *
 * The rows are the lines right above the hint, up to a blank line or a rule, exactly one of
 * them `❯`. A narrow pane wraps a long label onto the next line at the label's own indent, so
 * the indent cannot tell a wrapped label from the next row: words wrap only when the next one
 * no longer fits, so a line under a row continues it when its first word would not have fitted
 * after it. The widest line off the rows stands for the pane's width; a row wider than all of
 * them says nothing of it, and the line under it could be either — 'unsure', no card rather
 * than one that answers a row it does not show.
 * (ovis server/dialogs/claude.ts parseClaudeConfirm, MIT — the whole screen's text used to
 * become options when no row above them ended in "?".)
 */
function readConfirmMenu(lines: string[]): ConfirmMenu | 'unsure' | null {
    let hint = -1
    for (let index = lines.length - 1; index >= 0 && hint < 0; index--) if (/Enter to confirm/i.test(lines[index])) hint = index
    if (hint < 0) return null
    let end = hint - 1
    while (end >= 0 && !lines[end].trim()) end--
    let start = end
    // A line asking ("…?") is the panel's, not a row, even with no blank line under it.
    while (start > 0 && lines[start - 1].trim() && !DIVIDER.test(lines[start - 1]) && !/[?？]\s*$/.test(lines[start - 1])) start--
    if (end < 0) return null
    const width = Math.max(0, ...lines.filter((_, index) => index < start || index > end).map((line) => line.trimEnd().length))
    let unsure = false
    const wrappedFrom = (above: string, line: string): boolean => {
        if (above.trimEnd().length + 1 + (line.split(/\s+/)[0]?.length ?? 0) <= width) return false
        if (above.trimEnd().length > width) unsure = true
        return true
    }
    const rows: { label: string; selected: boolean }[] = []
    for (let index = start; index <= end; index++) {
        const line = lines[index].trim()
        const selected = /^[❯›>]/.test(line)
        const previous = rows[rows.length - 1]
        if (previous && !selected && wrappedFrom(lines[index - 1], line)) {
            previous.label = `${previous.label} ${line}`.replace(/\s+/g, ' ').trim()
            continue
        }
        rows.push({ label: line.replace(/^[❯›>]\s*/, '').trim(), selected })
    }
    if (unsure) return 'unsure'
    if (rows.length < 2 || rows.length > 9 || rows.filter((row) => row.selected).length !== 1) return null
    if (rows.some((row) => !row.label || NUMBERED_OPTION.test(row.label))) return null

    // The panel above the rows: its first line names it, a sentence ending in "?" asks.
    let top = start - 1
    while (top >= 0 && !DIVIDER.test(lines[top]) && start - top <= MENU_REGION_LINES) top--
    const panel = lines.slice(top + 1, start).map((line) => line.trim()).filter(Boolean)
    const prose = panel.join(' ').replace(/\s+/g, ' ')
    const found = /(?:^|[.:!]\s+)([^.:!?]*\?)/.exec(prose)
    const asked = found?.[1]?.trim()
    // What the panel says before its question (its title, the folder): the lines above the one it starts on.
    let askedAt = -1
    if (found && asked) {
        const offset = found.index + found[0].indexOf(asked)
        for (let index = 0, at = 0; index < panel.length && askedAt < 0; index++) {
            at += panel[index].replace(/\s+/g, ' ').length + 1
            if (offset < at) askedAt = index
        }
    }
    const context = (askedAt > 0 ? panel.slice(0, askedAt) : []).slice(0, CONTEXT_MAX_LINES)
    return {
        options: rows.map((row, index) => ({ index, number: null, label: row.label, selected: row.selected })),
        question: asked ?? panel[0]?.replace(/:$/, '') ?? '',
        context
    }
}

/** A rule drawn under a dialog: a full one, or Claude's with the tab title in it ("──── title ─"). */
const TRAILING_RULE = /^[─━╌]{8,}/

/**
 * One part of a key hint between its `·`: a key, "to", what it does ("Esc to cancel",
 * "ctrl+x ctrl+k twice to stop background agents", "n to add notes"). Text that is no such part
 * ("Password:", another program's words after the hint) means the hint row is not the menu's own.
 */
const HINT_PART = /^(?:press\s+)?(?:enter|esc|escape|tab|space|shift\+tab|ctrl\+\S+(?:\s+ctrl\+\S+)?(?:\s+twice)?|[↑↓←→]+(?:\/[↑↓←→]+)?|tab\/arrow keys|[a-z])\s+to\s+[a-z][a-z +/-]*$/i

/**
 * Whether the menu's key hint is the last thing drawn (rows are the non-blank rows, top to bottom).
 * The hint is the first footer row under the last option (the last "Enter to confirm" for an
 * unnumbered menu); what follows it may only be the rest of it (a narrow pane wraps it) and rules,
 * and all of it together must read as key hints. No hint found: nothing to tell by, the menu is
 * taken as drawn.
 * (ovis server/prompt.test.ts "is gone once the menu is answered", MIT)
 */
function menuIsLast(rows: string[], lastOptionRow: number, unnumbered: boolean): boolean {
    let hint = -1
    if (unnumbered) {
        for (let row = rows.length - 1; row >= 0 && hint < 0; row--) if (/Enter to confirm/i.test(rows[row])) hint = row
    } else {
        hint = rows.findIndex((line, row) => row > lastOptionRow && FOOTER.test(line))
    }
    if (hint < 0) return true
    const words = [rows[hint], ...rows.slice(hint + 1).filter((line) => !TRAILING_RULE.test(line.trim()))].join(' ').replace(/\s+/g, ' ')
    return words.split('·').map((part) => part.trim()).filter(Boolean).every((part) => HINT_PART.test(part))
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
    /** the column each option's number is drawn at */
    let numberColumn = -1
    for (let row = 0; row < rows.length; row++) {
        const line = rows[row]
        const trimmed = line.trim()
        const match = NUMBERED_OPTION.exec(trimmed)
        const column = match ? line.indexOf(`${match[2]}.`) : -1
        // A numbered line inside an option's description ("Runs these steps:" / "1. Install deps") sits
        // to the right of the options' own numbers: it is the description's, not a list starting again.
        if (match && options.length > 0 && row === lastOptionRow + 1 && column > numberColumn + 1) {
            const last = options[options.length - 1]
            last.description = last.description ? `${last.description} ${trimmed}` : trimmed
            lastOptionRow = row
            continue
        }
        if (match) {
            // A list that starts again (the agent's own numbered answer above the dialog): the last one is the menu.
            if (options.length > 0 && Number(match[2]) <= (options[options.length - 1].number ?? 0)) {
                options.length = 0
                firstOptionRow = -1
            }
            const label = match[3].trim()
            numberColumn = column
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

    // Claude's unnumbered menus (the folder-trust check): plain rows over "Enter to confirm".
    let confirm: ConfirmMenu | null = null
    if (options.length === 0 && /Enter to confirm/i.test(text)) {
        const read = readConfirmMenu(belowInputBox(screen).map(clean))
        if (read === 'unsure') return null
        confirm = read
        if (confirm) options.push(...confirm.options)
    }

    const above = firstOptionRow >= 0 ? rows.slice(0, firstOptionRow) : rows
    const questionAt = (() => {
        for (let row = above.length - 1; row >= 0; row--) if (/[?？]\s*$/.test(above[row].trim())) return row
        for (let row = above.length - 1; row >= 0; row--) if (MENU_MARKERS.some((marker) => marker.test(above[row]))) return row
        return -1
    })()
    const questionLine = confirm ? confirm.question : questionAt >= 0 ? above[questionAt].trim() : rows.find((line) => MENU_MARKERS.some((m) => m.test(line)))?.trim() ?? ''
    const question = questionLine.length > QUESTION_MAX ? `${questionLine.slice(0, QUESTION_MAX - 1)}…` : questionLine

    // The rows between the dialog's top edge (a full rule, or the prompt above it) and the question:
    // the command, the tab title. Dashed rules inside the dialog are skipped, not edges.
    let top = questionAt - 1
    while (top >= 0 && !isInputBoxRule(above[top].trim()) && !/^[❯>⏺●⎿]/.test(above[top].trim()) && questionAt - top <= CONTEXT_MAX_LINES * 2) top--
    // No edge found (Codex draws none): the rows above are the agent's output, not the dialog's.
    const edgeFound = top >= 0 && questionAt - top <= CONTEXT_MAX_LINES * 2
    const context = confirm ? confirm.context : (questionAt > 0 && edgeFound ? above.slice(top + 1, questionAt) : [])
        .map((line) => line.trim())
        .filter((line) => line && !SEPARATOR.test(line) && !/^Tip:/i.test(line))
        .slice(-CONTEXT_MAX_LINES)

    // An answered menu stays on screen above what came next ("● Done.", the welcome banner): open only
    // while nothing but its own key hint (wrapped, perhaps) and a rule sits under its hint row.
    if (agent === 'claude' && !menuIsLast(rows, confirm ? -1 : lastOptionRow, confirm !== null)) return null

    const multi = options.some((option) => CHECKBOX.test(option.label))
    const kind = kindOf([text, ...options.map((option) => option.label)].join('\n'), options)
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
