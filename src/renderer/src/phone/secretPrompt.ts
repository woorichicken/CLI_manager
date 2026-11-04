/**
 * Is the line the cursor sits on a password prompt? Ported from ovis shared/secret-prompt.ts
 * (secretPrompt, validSecret — MIT): deliberately narrow, so prose that mentions a password never
 * turns the phone's input line into a password field.
 *
 * `screen` is the terminal's text up to and including the cursor's row, one row per line.
 */
export function secretPrompt(screen: string, columns = Infinity): string | null {
    const lines = screen.split(/\r?\n/)
    while (lines.length && !lines[lines.length - 1]?.trim()) lines.pop()
    let line = lines.pop()?.trimEnd() ?? ''
    for (;;) {
        const candidate = line.trimStart()
        if (!candidate || candidate.length > 120 || /\?|y\s*\/\s*n/i.test(candidate)) return null
        if (
            /^(?:\[sudo\] password for [^:]+|[^\s@]+@[^\s:]+['’]s password|password(?: for [^:]+)?|enter passphrase(?: for key ['’][^\r\n]+['’])?|enter pin(?: for [^:]+)?|(?:repeat|verify|confirm) password):$/i.test(
                candidate
            )
        ) {
            return candidate
        }
        // a prompt longer than the screen is wide: join it to the row above only when that row reached the edge
        const previous = lines.pop()?.trimEnd()
        if (!previous || previous.length < columns - 1 || previous.length > columns) return null
        line = (previous.padEnd(columns) + line).trimStart()
    }
}

/** A secret is one line of literal keys: no terminal controls (ovis validSecret). */
export function validSecret(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\x00-\x1f\x7f-\x9f]/.test(value)
}

/** How many rows above the cursor `secretPrompt` may need to join a wrapped prompt. */
export const SECRET_PROMPT_ROWS = 3

/** The rows a prompt check reads: the cursor's row and a few above it, as text. */
export function cursorRowsText(rows: string[]): string {
    return rows.slice(-SECRET_PROMPT_ROWS).join('\n')
}
