/**
 * Reading text off a terminal screen. Pure functions over rows of text, kept
 * apart from TerminalMirror so they can be tested without a pty.
 */

/**
 * A full-width rule: Claude Code's input box edges, and the top edge of its
 * dialogs. Matched on the trimmed row. Heavy (━) too, and from 8 cells: a pane
 * narrower than 20 columns still draws a box (ovis server/dialogs/shared.ts
 * SOLID_RULE_RE, MIT).
 */
export const INPUT_BOX_RULE = /^[─━]{8,}$/

/**
 * A labelled rule over an input box: Claude's named session after `/rename`
 * (`──── my-session ─`), and OmO's own box while it works
 * (`── • Running eval (7s • esc to interrupt) ───`). Only the box readers take
 * it; a dialog's top edge stays INPUT_BOX_RULE. (ovis server/claude-input.ts
 * BOX_LABELED_RULE_RE, MIT — our port had left it out, and every Chat send to a
 * named session read the answer above the box as typed text.)
 */
const BOX_LABELED_RULE = /^─{2,}\s.*─$/

/**
 * A turn in progress. Codex (and Claude Code up to 2.1.31x) print "esc to interrupt" on the spinner row.
 * Claude Code 2.1.318 dropped that hint: its spinner row is only a glyph, a verb with an ellipsis and a
 * bracket that opens with the elapsed time or a hook it waits on — `✳ Galloping… (8s · ↓ 527 tokens)`,
 * `✻ Deciphering… (running UserPromptSubmit hooks… 0/2 · 0s)` (recorded 2026-11-05, 4359b4ee). A
 * settled turn's row has no ellipsis (`✻ Cogitated for 11s`), so it never matches.
 */
const ESC_TO_INTERRUPT = /esc to interrupt/i
/**
 * Codex's question (request_user_input, 0.166) names Esc in its own hint — `tab to add notes | enter to submit
 * answer | … | esc to interrupt` — while it waits on the person, not working (chat-gap-r3-1109, captured).
 */
const CODEX_ASK_HINT = /tab to add notes|enter to submit (?:answer|all)/i
const CLAUDE_SPINNER_ROW = /^\s*[·✢✳✶✻✽*]\s+[^\s()…][^()…]*…\s*\((?:\d|running\b)/

/** A screen row that says the agent is working on a turn (see above). */
export function isBusyRow(row: string): boolean {
    return (ESC_TO_INTERRUPT.test(row) && !CODEX_ASK_HINT.test(row)) || CLAUDE_SPINNER_ROW.test(row)
}

/** One edge of an agent's input box. `trimmed` is a row with its edges' blanks removed. */
export function isInputBoxRule(trimmed: string): boolean {
    return INPUT_BOX_RULE.test(trimmed) || BOX_LABELED_RULE.test(trimmed)
}

/** Claude Code's mode row under its input box: `⏵⏵ bypass permissions on (shift+tab to cycle)`, `⏸ plan mode on`. */
const MODE_ROW = /^\s*(?:⏵⏵|⏸)\s*(.+?)\s+on\b/u
const MODE_WORDS: Record<string, string> = { 'bypass permissions': 'bypass', 'plan mode': 'plan', 'auto mode': 'auto' }

/**
 * The mode the screen shows, in the chat's short words, or null when it shows none. Only under the
 * last input box rule: the same words in the conversation above are words, not the mode.
 */
export function screenAgentMode(rows: string[]): string | null {
    let start = -1
    for (let row = rows.length - 1; row >= 0; row--) {
        if (isInputBoxRule(rows[row].trim())) {
            start = row
            break
        }
    }
    if (start < 0) return null
    for (const row of rows.slice(start + 1)) {
        const words = MODE_ROW.exec(row)?.[1]?.toLowerCase()
        if (words) return MODE_WORDS[words] ?? words
    }
    return null
}

/** `· 1 shell`, `· 3 shells`, `← 1 agent`, `2 agents` on Claude's rows under its input box (2.1.319–2.1.322, captured). */
const BACKGROUND_SHELLS = /(?:^|[·\s])(\d+)\s+shells?\b/
const BACKGROUND_AGENTS = /(?:^|[·←\s])(\d+)\s+(?:background\s+)?agents?\b/

/**
 * Background shells and agents the screen counts, or null when it counts none. Only under the last input
 * box rule, like the mode: «1 shell» in the conversation above is words (fb-1110 a0ba98c4).
 */
export function screenBackground(rows: string[]): { shells: number; agents: number } | null {
    let start = -1
    for (let row = rows.length - 1; row >= 0; row--) {
        if (isInputBoxRule(rows[row].trim())) {
            start = row
            break
        }
    }
    if (start < 0) return null
    let shells = 0
    let agents = 0
    for (const row of rows.slice(start + 1)) {
        shells = Math.max(shells, Number(BACKGROUND_SHELLS.exec(row)?.[1] ?? 0))
        agents = Math.max(agents, Number(BACKGROUND_AGENTS.exec(row)?.[1] ?? 0))
    }
    return shells > 0 || agents > 0 ? { shells, agents } : null
}

/** Long enough for a sentence; the dialog truncates further to fit. */
const MAX_LAST_LINE_LENGTH = 200

/** A row with nothing to read: blank, or only box drawing, rules and spinner glyphs. */
const NOTHING_TO_READ = /^[\s─-╿▀-▟·•…⎿⏺❯>|]*$/

/** Where an agent's input box starts (its top rule), or -1 when the screen has none. */
function inputBoxTop(rows: string[]): number {
    const rules: number[] = []
    for (let row = rows.length - 1; row >= 0 && rules.length < 2; row--) {
        if (isInputBoxRule(rows[row].trim())) rules.push(row)
    }
    return rules.length === 2 ? rules[1] : -1
}

/**
 * The last row worth reading, for a one-line summary of what a session is
 * doing. Above an agent's input box when it draws one: the box and the hints
 * under it look the same on every screen. '' when nothing qualifies.
 */
export function lastMeaningfulLine(rows: string[]): string {
    const top = inputBoxTop(rows)
    const end = top >= 0 ? top : rows.length

    for (let row = end - 1; row >= 0; row--) {
        const text = rows[row].replace(/\s+/g, ' ').trim()
        if (NOTHING_TO_READ.test(text)) continue
        return text.length > MAX_LAST_LINE_LENGTH ? `${text.slice(0, MAX_LAST_LINE_LENGTH - 1)}…` : text
    }
    return ''
}

/** Claude Code's summary after a turn: `※ recap: …`, wrapped onto indented rows. */
const RECAP_START = /^※\s*recap:\s*/
const RECAP_HINT = /\s*\(disable recaps in \/config\)\s*$/
const MAX_RECAP_LENGTH = 400

/**
 * The last `※ recap:` on the screen as one sentence, without its
 * "(disable recaps in /config)" hint; '' when there is none.
 */
export function recapOf(rows: string[]): string {
    for (let start = rows.length - 1; start >= 0; start--) {
        if (!RECAP_START.test(rows[start].trim())) continue
        const parts = [rows[start].trim().replace(RECAP_START, '')]
        // Claude Code wraps the recap itself, indenting the rows that continue it.
        for (let row = start + 1; row < rows.length && /^\s+\S/.test(rows[row]); row++) {
            if (isInputBoxRule(rows[row].trim())) break
            parts.push(rows[row].trim())
        }
        const text = parts.join(' ').replace(/\s+/g, ' ').replace(RECAP_HINT, '').trim()
        return text.length > MAX_RECAP_LENGTH ? `${text.slice(0, MAX_RECAP_LENGTH - 1)}…` : text
    }
    return ''
}

export interface ScreenSummary {
    text: string
    /** `text` is the agent's own recap of the session, not a raw row off the screen. */
    isRecap: boolean
}

/**
 * One line about a session for the Related dialog. With an agent input box on
 * screen the rows above it are the transcript's tail — a timer, half a
 * sentence — so only the agent's recap is worth showing, and nothing when it
 * has none. Without a box (a shell, a question waiting) the last row is it.
 */
export function screenSummary(rows: string[]): ScreenSummary {
    const top = inputBoxTop(rows)
    if (top < 0) return { text: lastMeaningfulLine(rows), isRecap: false }
    const recap = recapOf(rows.slice(0, top))
    return { text: recap, isRecap: recap !== '' }
}
