import { createHash } from 'crypto'
import type { ConversationAgent, PromptAnswer, PromptKind, PromptMenu, PromptOption, PromptStep } from '../shared/conversation'
import { INPUT_BOX_RULE, isBusyRow, isInputBoxRule } from './screenLines'

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
 * Round chat-gap-1109 added, each from copies of real screens (fixtures/prompts,
 * Claude Code 2.1.319 · codex-cli 0.166.0, the keys pressed while capturing them):
 * Claude's question tabs as steps, its multiple choice (Enter ticks a row, Enter on
 * the Next/Submit row goes on), its review of the answers ("Ready to submit your
 * answers?" — no key hint under it) and its plan approval; Codex's command and edit
 * approvals ("No … (esc)" is Esc, ovis `server/dialogs/codex.ts`). Codex's folder
 * trust stays display only — the startup watcher answers it.
 */

// A turn in progress (`isBusyRow`): a real question replaces the spinner (checked on 2.1.312).

/** The footers and phrases of a menu waiting on the user. */
const MENU_MARKERS = [
    /Enter to confirm/i,
    /Enter to select/i,
    /Esc to cancel/i,
    /trust this folder/i,
    /Do you trust the contents of this directory/i,
    /Press enter to continue/i,
    /Do you want to (proceed|make|create|allow|run)/i,
    /Would you like to (run|make|apply|proceed)/i,
    /Ready to submit your answers\?/i,
    // Codex's request_user_input (0.166): its hint row
    /tab to add notes/i,
    // the plan approval's first words: a narrow pane wraps "Would you like to proceed?" apart
    /written up a plan/i
]

/** Footer rows: hints about keys, not part of the question. */
const FOOTER = /(Enter to (confirm|select)|Esc to cancel|to navigate|Tab to amend|Press enter to continue|tab to add notes)/i

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

/** Claude's question tabs over the question: `←  ☐ Color  ☒ Fruits  ✔ Submit  →` (cut off by a narrow pane: no →) */
const TAB_BAR = /^←\s+[☐☒☑✔]/

/** One question's header over it: ` ☐ Color ` (2.1.312, 2.1.322) — several questions draw TAB_BAR instead */
const QUESTION_HEADER = /^[☐☒☑✔]\s+\S/

/**
 * An AskUserQuestion whose options carry a `preview` (2.1.322): the options on the left, the highlighted
 * one's preview in a box to their right, its top edge on an option's row (fb-1110 4f10a0fc, captured).
 * Descriptions are not drawn in this layout: a row indented under an option is its label wrapped.
 */
const PREVIEW_BOX_TOP = /^\s*[❯›>]?\s*\d{1,2}\.\s+\S.*?\s{2,}┌─{6,}┐\s*$/
const PREVIEW_BOX_BOTTOM = /└─{6,}┘\s*$/
/** where the right column starts on a row inside the box: its edge after two blanks, or at the row's start */
const PREVIEW_EDGE = /\s{2,}[│┌└]|^\s*[│┌└]/
/** the notes hint under the box («Notes: press n to add notes»), drawn in the right column */
const PREVIEW_NOTES = /^\s{8,}Notes:/

/** A multiple choice's tick box at the start of its label: `[ ] Apple`, `[✔] Apple` (2.1.319) */
const CHECKBOX_LABEL = /^\[([ xX✔✓])\]\s+(.+)$/

/** The unnumbered row a multiple choice draws under its typed answer, the cursor on it or not */
const SUBMIT_ROW = /^([❯›>])?\s*(Next|Submit)$/

const REVIEW_QUESTION = /^Ready to submit your answers\?$/i
const REVIEW_OPTIONS = ['Submit answers', 'Cancel']
/** the most answers a review card lists (one line each) */
const REVIEW_MAX_LINES = 12

/** Claude's plan approval (ExitPlanMode, 2.1.319) and its typed-feedback row */
const PLAN_QUESTION = /written up a plan and is ready to execute/i
const PLAN_CUSTOM = /^Tell Claude what to change$/i
/** the most plan lines a card carries — the card scrolls; the whole plan is in the terminal */
const PLAN_MAX_LINES = 40
/** what may stand under a plan's options: its key hint and the plan file */
const PLAN_FOOTER = /ctrl\+g to edit|Esc to/i

/** Codex's approval question (its first row — a narrow pane wraps it), the hint that closes it, the key after each option */
const CODEX_APPROVAL = /^Would you like to (run|make|apply)\b/i
/** the most rows a wrapped question takes (40 columns wrap the plan's over three) */
const QUESTION_WRAP_ROWS = 4
const CODEX_HINT = /^Press enter to confirm or esc to cancel$/i
const CODEX_KEY_SUFFIX = /\s+\((y|p|a|n|esc)\)$/i
/**
 * Codex's request_user_input (0.166, captured 2026-11-09 with `--enable default_mode_request_user_input`):
 * «Question 1/2 (2 unanswered)», the question, `› 1. Red    Choose red.` rows whose last is «None of the
 * above», and this hint. Measured: ↑/↓ move, Enter submits the highlighted one (the last question: all of
 * them); on «None of the above» Tab opens a notes line, the words go there, Enter submits — recorded as
 * `["None of the above", "user_note: <words>"]`. Esc interrupts the turn: no answer.
 */
const CODEX_ASK_HINT = /tab to add notes.*enter to submit (?:answer|all).*esc to interrupt/i
const CODEX_ASK_PROGRESS = /^Question (\d+)\/(\d+)\b/
const CODEX_ASK_CUSTOM = /^None of the above$/i

/**
 * Claude Code's MCP elicitation with no fields (2.1.319, fb 58814f80): «MCP server "x" requests your input»
 * (a narrow pane wraps it), the server's words, `❯ Accept    Decline` on one row. Measured with a test
 * server: Enter sends the highlighted one, ↑/↓ go round the two, Esc cancels.
 */
const MCP_HEADER_START = /^MCP server\b/
const MCP_HEADER_END = /requests your input$/i
const MCP_CHOICE = /^([❯›>])?\s*Accept\s{2,}([❯›>])?\s*Decline$/
/** the most rows between the header and the choice row */
const MCP_PANEL_ROWS = 16

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
    if (screen.some(isBusyRow)) return null
    const { rows: drawn, preview } = withoutPreview(belowInputBox(screen))
    const rows = drawn
        .map(clean)
        .filter((line) => line.trim() !== '')
        .slice(-MENU_REGION_LINES)
    if (agent === 'claude') {
        const mcp = readMcpConfirm(rows)
        if (mcp) return mcp
    }
    const text = rows.join('\n')
    if (!MENU_MARKERS.some((marker) => marker.test(text))) return null

    // Numbered options, with the indented rows under each as its description.
    const options: PromptOption[] = []
    let submitRow: PromptMenu['submitRow']
    let firstOptionRow = -1
    let lastOptionRow = -1
    /** the column each option's number is drawn at */
    let numberColumn = -1
    for (let row = 0; row < rows.length; row++) {
        const line = rows[row]
        const trimmed = line.trim()
        // a multiple choice's Next/Submit row: a place the cursor stops, not the last option's description
        const submitMatch = options.some((option) => option.checked !== undefined) ? SUBMIT_ROW.exec(trimmed) : null
        if (submitMatch && row === lastOptionRow + 1) {
            submitRow = { label: submitMatch[2], selected: submitMatch[1] !== undefined, after: options.length - 1 }
            continue
        }
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
                submitRow = undefined
            }
            let label = match[3].trim()
            const box = CHECKBOX_LABEL.exec(label)
            if (box) label = box[2].trim()
            numberColumn = column
            if (firstOptionRow < 0) firstOptionRow = row
            lastOptionRow = row
            options.push({
                index: options.length,
                number: Number(match[2]),
                label,
                selected: match[1] !== undefined,
                ...(CUSTOM_OPTION.test(label) ? { custom: true } : {}),
                ...(box ? { checked: box[1] !== ' ' } : {})
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

    // the preview layout draws no descriptions: what sits under an option is its label, wrapped
    if (preview) {
        for (const option of options) {
            if (option.description) option.label = `${option.label} ${option.description}`
            delete option.description
        }
    }

    // Codex's options have no descriptions: rows under one are its label wrapped by a narrow pane, and the
    // key named at its end ("Yes, proceed (y)", "No, … (esc)") may stand on the last of them.
    // Codex's question: label and description on one row, two spaces or more between them
    const codexQuestion = agent === 'codex' && CODEX_ASK_HINT.test(rows.slice(lastOptionRow + 1).map((line) => line.trim()).join(' '))
    if (codexQuestion) {
        for (const option of options) {
            const [label, ...rest] = option.label.split(/\s{2,}/)
            option.label = label.trim()
            const description = [rest.join(' '), option.description ?? ''].join(' ').replace(/\s+/g, ' ').trim()
            if (description) option.description = description
            else delete option.description
            if (CODEX_ASK_CUSTOM.test(option.label)) option.custom = true
        }
    }
    if (agent === 'codex' && !codexQuestion) {
        for (const option of options) {
            if (option.description) option.label = `${option.label} ${option.description}`
            delete option.description
            const key = CODEX_KEY_SUFFIX.exec(option.label)
            if (!key) continue
            option.label = option.label.slice(0, key.index).trim()
            if (key[1].toLowerCase() === 'esc') option.escape = true
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
    // Codex's approval asks above the lines it explains ("Reason: …?" under it ends in "?" too);
    // a narrow pane wraps it: it ends on the first row ending in "?"
    const codexFrom = agent === 'codex' ? findLast(above, (line) => CODEX_APPROVAL.test(line.trim())) : -1
    let codexAt = -1
    for (let row = codexFrom; row >= 0 && row < above.length && row < codexFrom + QUESTION_WRAP_ROWS && codexAt < 0; row++) {
        if (/\?\s*$/.test(above[row].trim())) codexAt = row
    }
    const asked = agent === 'claude' && !confirm && firstOptionRow > 0 ? claudeQuestionRows(above) : -1
    const questionAt = (() => {
        if (codexAt >= 0) return codexAt
        if (asked >= 0) return above.length - 1
        for (let row = above.length - 1; row >= 0; row--) if (/[?？]\s*$/.test(above[row].trim())) return row
        for (let row = above.length - 1; row >= 0; row--) if (MENU_MARKERS.some((marker) => marker.test(above[row]))) return row
        return -1
    })()
    let questionLine = confirm ? confirm.question : questionAt >= 0 ? above[questionAt].trim() : rows.find((line) => MENU_MARKERS.some((m) => m.test(line)))?.trim() ?? ''
    const joined = (from: number): string => above.slice(from, questionAt + 1).map((line) => line.trim()).join(' ')
    /** the question's first row: a narrow pane wraps it over the rows above its last */
    let questionStart = questionAt
    if (asked >= 0) {
        questionLine = joined(asked)
        questionStart = asked
    }
    if (codexAt > codexFrom) {
        questionLine = joined(codexFrom)
        questionStart = codexFrom
    }
    for (let back = 1; back < QUESTION_WRAP_ROWS && questionAt - back >= 0 && !PLAN_QUESTION.test(questionLine); back++) {
        if (PLAN_QUESTION.test(joined(questionAt - back))) {
            questionLine = joined(questionAt - back)
            questionStart = questionAt - back
        }
    }
    const question = questionLine.length > QUESTION_MAX ? `${questionLine.slice(0, QUESTION_MAX - 1)}…` : questionLine
    const review = !confirm && REVIEW_QUESTION.test(questionLine)
    const plan = !confirm && agent === 'claude' && PLAN_QUESTION.test(questionLine)
    const steps = readSteps(above, questionAt)

    // The rows between the dialog's top edge (a full rule, or the prompt above it) and the question:
    // the command, the tab title. Dashed rules inside the dialog are skipped, not edges.
    // (from the question's first row: a wrapped question is the question, not context above it)
    let top = questionStart - 1
    while (top >= 0 && !INPUT_BOX_RULE.test(above[top].trim()) && !/^[❯>⏺●⎿]/.test(above[top].trim()) && questionStart - top <= CONTEXT_MAX_LINES * 2) top--
    // No edge found (Codex draws none): the rows above are the agent's output, not the dialog's.
    const edgeFound = top >= 0 && questionStart - top <= CONTEXT_MAX_LINES * 2
    const progress = codexQuestion ? findLast(above, (line) => CODEX_ASK_PROGRESS.test(line.trim())) : -1
    const progressMatch = progress >= 0 ? CODEX_ASK_PROGRESS.exec(above[progress].trim()) : null
    const context = codexQuestion
        ? progressMatch && progressMatch[2] !== '1' ? [`Question ${progressMatch[1]} of ${progressMatch[2]}`] : []
        : confirm
        ? confirm.context
        : review
          ? reviewAnswers(above, questionAt)
          : plan
            ? planLines(above, questionStart)
            : codexAt >= 0
              ? above.slice(codexAt + 1).map((line) => line.trim()).filter(Boolean).slice(0, CONTEXT_MAX_LINES)
              : (questionAt > 0 && edgeFound ? above.slice(top + 1, questionStart) : [])
                    .map((line) => line.trim())
                    .filter((line) => line && !SEPARATOR.test(line) && !/^Tip:/i.test(line) && !TAB_BAR.test(line))
                    .slice(-CONTEXT_MAX_LINES)
    if (plan) for (const option of options) if (PLAN_CUSTOM.test(option.label)) option.custom = true

    // Claude draws no key hint under its review or its plan: they are open only while nothing else is
    // under their options (an answered one stays above "⏺ User answered …").
    const tail = lastOptionRow >= 0 ? rows.slice(lastOptionRow + 1) : []
    if (review && (options.map((option) => option.label).join('\n') !== REVIEW_OPTIONS.join('\n') || tail.length > 0 && !(FOOTER.test(tail[0]) && menuIsLast(rows, lastOptionRow, false)))) return null
    // (its hint and plan file, wrapped over a few rows by a narrow pane)
    if (plan && tail.length > 0 && !(tail.length <= 3 && PLAN_FOOTER.test(tail[0]))) return null

    // An answered menu stays on screen above what came next ("● Done.", the welcome banner): open only
    // while nothing but its own key hint (wrapped, perhaps) and a rule sits under its hint row.
    if (agent === 'claude' && !menuIsLast(rows, confirm ? -1 : lastOptionRow, confirm !== null)) return null

    const multi = options.some((option) => option.checked !== undefined || CHECKBOX.test(option.label))
    const kind: PromptKind = review ? 'review' : plan ? 'plan' : kindOf([text, ...options.map((option) => option.label)].join('\n'), options)
    const highlighted = options.some((option) => option.selected)
    // A multiple choice is answered only in the layout captured: tick boxes and the Next/Submit row under them.
    const claudeAnswerable = agent === 'claude' && options.length > 0 && (multi ? submitRow !== undefined && (highlighted || submitRow.selected) : highlighted)
    // Codex: its command and edit approvals, closed by their own hint and nothing after it (ovis codex.ts:147-166)
    // (the hint alone under the options, wrapped by a narrow pane perhaps)
    const codexAnswerable = agent === 'codex' && kind === 'permission' && codexAt >= 0 && highlighted &&
        CODEX_HINT.test(tail.map((line) => line.trim()).join(' '))
    // Codex's question: open while its hint is all that is under its rows; the last row takes typed words
    const codexAsks = codexQuestion && highlighted && options.at(-1)?.custom === true &&
        CODEX_ASK_HINT.test(tail.map((line) => line.trim()).join(' '))
    const answerable = claudeAnswerable || codexAnswerable || codexAsks
    const selected = options.findIndex((option) => option.selected)
    // A hash, not the words: the card goes to a phone with its words masked (maskSnapshot), and a plain
    // JSON signature carried the unmasked command — a key in it — right beside them (ovis dialogs/shared.ts:331).
    // Ticks are left out: the answer names the rows to leave ticked, read again when it is sent.
    const signature = createHash('sha256')
        .update(JSON.stringify([agent, kind, question, context, options.map((option) => option.label), selected, submitRow?.selected ?? null]))
        .digest('hex')
    return { agent, kind, question, context, options, multi, ...(submitRow ? { submitRow } : {}), ...(steps ? { steps } : {}), answerable, signature }
}

/**
 * An MCP server's Accept / Decline (Q-5), or null. Open only while its key hint is the last thing drawn.
 * Cancel is the dialog's Esc («Esc to cancel»): no row of its own, offered as an option that presses Esc.
 */
function readMcpConfirm(rows: string[]): PromptMenu | null {
    const choiceAt = findLast(rows, (line) => MCP_CHOICE.test(line.trim()))
    if (choiceAt < 0 || !menuIsLast(rows, choiceAt, false) || rows.length - choiceAt > 4) return null
    let headerAt = -1
    for (let row = choiceAt - 1; row >= 0 && choiceAt - row <= MCP_PANEL_ROWS && headerAt < 0; row--) if (MCP_HEADER_START.test(rows[row].trim())) headerAt = row
    if (headerAt < 0) return null
    let headerEnd = headerAt
    while (headerEnd < choiceAt - 1 && headerEnd - headerAt < QUESTION_WRAP_ROWS && !MCP_HEADER_END.test(rows[headerEnd].trim())) headerEnd++
    if (!MCP_HEADER_END.test(rows[headerEnd].trim())) return null
    const header = rows.slice(headerAt, headerEnd + 1).map((line) => line.trim()).join(' ')
    const panel = rows.slice(headerEnd + 1, choiceAt).map((line) => line.trim()).filter((line) => line && !SEPARATOR.test(line))
    const askedAt = findLast(panel, (line) => /[?？]$/.test(line))
    const question = askedAt >= 0 ? panel[askedAt] : header
    const context = [header, ...(askedAt >= 0 ? panel.slice(0, askedAt) : panel)].slice(0, CONTEXT_MAX_LINES)
    const choice = MCP_CHOICE.exec(rows[choiceAt].trim())!
    const options: PromptOption[] = [
        { index: 0, number: null, label: 'Accept', selected: choice[1] !== undefined },
        { index: 1, number: null, label: 'Decline', selected: choice[2] !== undefined },
        { index: 2, number: null, label: 'Cancel', selected: false, escape: true }
    ]
    const selected = options.findIndex((option) => option.selected)
    const signature = createHash('sha256')
        .update(JSON.stringify(['claude', 'mcp', question, context, options.map((option) => option.label), selected]))
        .digest('hex')
    return {
        agent: 'claude',
        kind: 'permission',
        question: question.length > QUESTION_MAX ? `${question.slice(0, QUESTION_MAX - 1)}…` : question,
        context,
        options,
        multi: false,
        answerable: options.filter((option) => option.selected).length === 1,
        signature
    }
}

/**
 * Claude's AskUserQuestion: the first row of its question, or -1. The question is every row between its
 * header (the tab bar, or « ☐ Color » for one question) and the first option — 2.1.322 wraps a long one
 * in a «│» quote bar, and it need not end in «?» («Pick a color», «…권했습니다.)» — fb-1110 4f10a0fc: the
 * row ending in «?» was looked for, none was, and the card named its key hint as the question).
 * Not the review of the answers nor a plan approval: their question is a row of its own under more rows.
 */
function claudeQuestionRows(above: string[]): number {
    const header = findLast(above, (line) => TAB_BAR.test(line.trim()) || QUESTION_HEADER.test(line.trim()))
    if (header < 0 || header === above.length - 1) return -1
    const block = above.slice(header + 1).map((line) => line.trim())
    if (block.length > QUESTION_WRAP_ROWS * 2 || block.some((line) => REVIEW_QUESTION.test(line) || PLAN_QUESTION.test(line))) return -1
    return header + 1
}

/**
 * The screen with an AskUserQuestion's preview column cut off its rows (see PREVIEW_BOX_TOP): its box
 * edges were read as part of the options' labels, its lines as more labels. Other screens come back as
 * they were. Cut at the box's edge character, not a column: a wide (Hangul) cell is one character.
 */
function withoutPreview(screen: string[]): { rows: string[]; preview: boolean } {
    const top = screen.findIndex((line) => PREVIEW_BOX_TOP.test(line))
    if (top < 0) return { rows: screen, preview: false }
    let bottom = -1
    for (let row = top + 1; row < screen.length && bottom < 0; row++) if (PREVIEW_BOX_BOTTOM.test(screen[row])) bottom = row
    if (bottom < 0) return { rows: screen, preview: false }
    const rows = screen.map((line, row) => {
        if (row > bottom && row <= bottom + 3 && PREVIEW_NOTES.test(line)) return ''
        if (row < top || row > bottom) return line
        const edge = line.search(PREVIEW_EDGE)
        return edge < 0 ? line : line.slice(0, edge)
    })
    return { rows, preview: true }
}

function findLast(lines: string[], test: (line: string) => boolean): number {
    for (let index = lines.length - 1; index >= 0; index--) if (test(lines[index])) return index
    return -1
}

/** The question tabs over the question, read from the bar's marks; none when no bar sits between it and the panel's rule. */
function readSteps(above: string[], questionAt: number): PromptStep[] | undefined {
    for (let row = (questionAt >= 0 ? questionAt : above.length) - 1; row >= 0; row--) {
        const line = above[row].trim()
        if (INPUT_BOX_RULE.test(line)) return undefined
        if (!TAB_BAR.test(line)) continue
        const tabs = line.replace(/^←\s*/, '').replace(/\s*→\s*$/, '').split(/\s{2,}/).filter(Boolean)
        return tabs.map((tab) => {
            const mark = tab[0]
            const label = tab.slice(1).trim()
            return mark === '✔' ? { label, answered: false, submit: true as const } : { label, answered: mark === '☒' || mark === '☑' }
        })
    }
    return undefined
}

/**
 * The review's answers, one line each: `● Which fruits?` over `→ Apple, Cherry` becomes
 * "Which fruits? → Apple, Cherry"; a line opening neither continues the one above (a wrapped answer).
 */
function reviewAnswers(above: string[], questionAt: number): string[] {
    let top = questionAt - 1
    while (top >= 0 && !TAB_BAR.test(above[top].trim()) && !INPUT_BOX_RULE.test(above[top].trim())) top--
    const items: string[] = []
    for (const raw of above.slice(top + 1, questionAt)) {
        const line = raw.trim()
        if (/^●\s+/.test(line)) items.push(line.replace(/^●\s+/, ''))
        else if (/^→\s+/.test(line) && items.length > 0) items[items.length - 1] += ` → ${line.replace(/^→\s+/, '')}`
        else if (items.length > 0 && line) items[items.length - 1] += ` ${line}`
    }
    return items.slice(0, REVIEW_MAX_LINES)
}

/** The plan over its question, from "Ready to code?" (or what is left of the panel) down to the rule above the question. */
function planLines(above: string[], questionAt: number): string[] {
    let row = questionAt - 1
    while (row >= 0 && INPUT_BOX_RULE.test(above[row].trim())) row--
    const lines: string[] = []
    for (; row >= 0; row--) {
        const line = above[row].trim()
        if (/^Ready to code\?$/i.test(line) || INPUT_BOX_RULE.test(line) || /^[⏺●❯]/.test(line)) break
        if (!line || DIVIDER.test(line) || SEPARATOR.test(line) || /^Here is Claude's plan:?$/i.test(line)) continue
        lines.unshift(line)
    }
    return lines.slice(0, PLAN_MAX_LINES)
}

export const KEYS = {
    up: '\x1b[A',
    down: '\x1b[B',
    enter: '\r',
    esc: '\x1b',
    tab: '\t'
} as const

/** One step of an answer: a key, or text typed as it is. */
export type AnswerStep = { key: string } | { text: string }

export class PromptAnswerError extends Error {}

/**
 * The keys that give `answer` to `menu`: arrows from the highlighted option to
 * the chosen one, then Enter. "Type something." takes the words typed into its
 * row, then Enter (no Enter before — the row is already the text field).
 * A multiple choice: Enter on each row whose tick differs from the answer, then
 * Enter on its Next/Submit row. Codex's "No … (esc)": Esc.
 * The answer's shape is checked here: a phone sends it as JSON.
 */
export function answerSteps(menu: PromptMenu, answer: PromptAnswer): AnswerStep[] {
    if (!menu.answerable) throw new PromptAnswerError('Answer this question in the terminal.')
    if (!answer || typeof answer !== 'object') throw new PromptAnswerError('Pick an option or type an answer.')
    const submit = menu.submitRow
    /** where the cursor stops for an option: the Next/Submit row sits between two options */
    const position = (index: number): number => (submit && index > submit.after ? index + 1 : index)
    const selectedIndex = menu.options.findIndex((option) => option.selected)
    let cursor = selectedIndex >= 0 ? position(selectedIndex) : submit?.selected ? submit.after + 1 : -1
    const steps: AnswerStep[] = []
    const moveTo = (to: number): void => {
        if (cursor < 0) throw new PromptAnswerError('No option is highlighted on screen.')
        const key = to > cursor ? KEYS.down : KEYS.up
        for (let i = 0; i < Math.abs(to - cursor); i++) steps.push({ key })
        cursor = to
    }
    const typed = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')

    if ('optionIndices' in answer) {
        if (!menu.multi || !submit) throw new PromptAnswerError('This question takes one answer.')
        const indices = answer.optionIndices
        if (!Array.isArray(indices) || indices.some((index) => !Number.isInteger(index) || menu.options[index]?.checked === undefined || menu.options[index].custom)) {
            throw new PromptAnswerError('That option is not on screen.')
        }
        if ('customText' in answer && typeof answer.customText !== 'string') throw new PromptAnswerError('Type the answer as text.')
        const text = typed(answer.customText)
        if (indices.length === 0 && !text) throw new PromptAnswerError('Pick one or more options.')
        const wanted = new Set(indices)
        for (const option of menu.options) {
            if (option.checked === undefined || option.custom || wanted.has(option.index) === option.checked) continue
            moveTo(position(option.index))
            steps.push({ key: KEYS.enter })
        }
        if (text) {
            const custom = menu.options.find((option) => option.custom)
            if (!custom) throw new PromptAnswerError('This question takes no typed answer.')
            // typing into the row ticks it (ovis prompt.ts:457, measured on 2.1.301)
            moveTo(position(custom.index))
            steps.push({ text })
        }
        moveTo(submit.after + 1)
        steps.push({ key: KEYS.enter })
        return steps
    }
    if ('customText' in answer) {
        if (menu.multi) throw new PromptAnswerError('Tick the options, then go on.')
        const custom = menu.options.find((option) => option.custom)
        const text = typed(answer.customText)
        if (!custom) throw new PromptAnswerError('This question takes no typed answer.')
        if (!text) throw new PromptAnswerError('Type an answer first.')
        moveTo(position(custom.index))
        // Codex's «None of the above» takes its words in a notes line Tab opens (measured, 0.166)
        const notes = menu.agent === 'codex' && menu.kind === 'question' ? [{ key: KEYS.tab }] : []
        return [...steps, ...notes, { text }, { key: KEYS.enter }]
    }
    if (!('optionIndex' in answer) || !Number.isInteger(answer.optionIndex)) throw new PromptAnswerError('Pick an option or type an answer.')
    const target = menu.options[answer.optionIndex]
    if (!target) throw new PromptAnswerError('That option is not on screen.')
    if (target.custom) throw new PromptAnswerError('Type the answer for this option.')
    if (target.checked !== undefined) throw new PromptAnswerError('Tick the options, then go on.')
    if (target.escape) return [{ key: KEYS.esc }]
    moveTo(position(target.index))
    return [...steps, { key: KEYS.enter }]
}

/**
 * The option that must be highlighted when the first key that is no arrow goes (main reads the
 * screen again right before it): -1 for a multiple choice's Next/Submit row. Esc moves nothing:
 * the highlight stays where the menu had it.
 */
export function confirmTarget(menu: PromptMenu, answer: PromptAnswer): number {
    const selected = menu.options.findIndex((option) => option.selected)
    if ('optionIndices' in answer) {
        const wanted = new Set(answer.optionIndices)
        const toggle = menu.options.find((option) => option.checked !== undefined && !option.custom && wanted.has(option.index) !== option.checked)
        if (toggle) return toggle.index
        if (typeof answer.customText === 'string' && answer.customText.trim()) return menu.options.findIndex((option) => option.custom)
        return -1
    }
    if ('customText' in answer) return menu.options.findIndex((option) => option.custom)
    return menu.options[answer.optionIndex]?.escape ? selected : answer.optionIndex
}
