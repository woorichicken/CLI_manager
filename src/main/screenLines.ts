/**
 * Reading text off a terminal screen. Pure functions over rows of text, kept
 * apart from TerminalMirror so they can be tested without a pty.
 */

/**
 * Claude Code draws its input box between two full-width rules. Matched on the
 * trimmed row, so a rule with a label inside it does not count.
 */
export const INPUT_BOX_RULE = /^─{20,}$/

/** Long enough for a sentence; the dialog truncates further to fit. */
const MAX_LAST_LINE_LENGTH = 200

/** A row with nothing to read: blank, or only box drawing, rules and spinner glyphs. */
const NOTHING_TO_READ = /^[\s─-╿▀-▟·•…⎿⏺❯>|]*$/

/** Where an agent's input box starts (its top rule), or -1 when the screen has none. */
function inputBoxTop(rows: string[]): number {
    const rules: number[] = []
    for (let row = rows.length - 1; row >= 0 && rules.length < 2; row--) {
        if (INPUT_BOX_RULE.test(rows[row].trim())) rules.push(row)
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
            if (INPUT_BOX_RULE.test(rows[row].trim())) break
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
