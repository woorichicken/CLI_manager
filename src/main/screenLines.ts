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

/**
 * The last row worth reading, for a one-line summary of what a session is
 * doing. Above an agent's input box when it draws one: the box and the hints
 * under it look the same on every screen. '' when nothing qualifies.
 */
export function lastMeaningfulLine(rows: string[]): string {
    let end = rows.length
    const rules: number[] = []
    for (let row = rows.length - 1; row >= 0 && rules.length < 2; row--) {
        if (INPUT_BOX_RULE.test(rows[row].trim())) rules.push(row)
    }
    if (rules.length === 2) end = rules[1]

    for (let row = end - 1; row >= 0; row--) {
        const text = rows[row].replace(/\s+/g, ' ').trim()
        if (NOTHING_TO_READ.test(text)) continue
        return text.length > MAX_LAST_LINE_LENGTH ? `${text.slice(0, MAX_LAST_LINE_LENGTH - 1)}…` : text
    }
    return ''
}
