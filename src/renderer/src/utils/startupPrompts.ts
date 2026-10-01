/**
 * Questions an agent CLI can ask before a restored session gets back to work,
 * answered so the restore actually restores. Only for sessions the app resumes
 * (`--resume` / `resume`): the conversation already ran in that folder, so the
 * answers only give back what the restart took away. A session started fresh is
 * left to the person.
 *
 * Seen 2026-10-01:
 * - Claude Code 2.1.286 asks "Is this a project you created or one you trust?"
 *   in any folder without a trust record — always in the home folder, which it
 *   never records. The cursor starts on "No, exit"; a stray Enter quits.
 * - Codex 0.155.1 asks to update whenever a newer release exists, with
 *   "1. Update now (runs brew upgrade …)" highlighted — Enter would upgrade.
 *   We pick "2. Skip": the session comes back and nothing is installed.
 * - Codex asks "Do you trust the contents of this directory?" with
 *   "1. Yes, continue" highlighted; it records the answer, so a restored
 *   session in a folder it already ran in rarely sees it.
 */

/** The highlighted option starts with a pointer glyph. */
const OPTION_CURSOR = /^\s*[❯›>]\s/
/** Rows above or below the wanted option where the highlighted one can be. */
const OPTION_WINDOW = 3
const ARROW_DOWN = '\x1b[B'
const ARROW_UP = '\x1b[A'
const ENTER = '\r'

const CLAUDE_TRUST_YES = /Yes, I trust this folder/
const CODEX_UPDATE = /Update available!/
const CODEX_UPDATE_SKIP = /^\s*(?:[❯›>]\s*)?2\.\s*Skip\s*$/
/** Measured: "2" alone picks Skip and closes the question. */
const CODEX_SKIP_KEY = '2'
const CODEX_TRUST = /Do you trust the contents of this directory/
const CODEX_TRUST_YES = /\bYes, continue\b/

/** How long after a resume a question may still appear. Agents take seconds to start under load. */
export const STARTUP_PROMPT_WATCH_MS = 60_000

/**
 * Gap between key presses. Sent as one write, "arrow + Enter" reached Claude
 * Code as a single chunk and was ignored — the real dialog stayed on "No, exit"
 * while the mock accepted it (2026-10-01). Separate writes are read as keys.
 */
const KEY_GAP_MS = 120

/** Arrows from the highlighted option to `target`, then Enter. Null when no highlighted option is near it. */
function moveToAndConfirm(lines: string[], target: number): string[] | null {
    // The highlighted option is the pointer row nearest to the target: the
    // agent's own input prompt ("❯ …") can sit a few rows above and must not win.
    let cursor = -1
    for (let distance = 0; distance <= OPTION_WINDOW && cursor < 0; distance++) {
        for (const row of [target - distance, target + distance]) {
            if (row >= 0 && row < lines.length && OPTION_CURSOR.test(lines[row])) {
                cursor = row
                break
            }
        }
    }
    if (cursor < 0) return null
    const distance = target - cursor
    return [...Array<string>(Math.abs(distance)).fill(distance > 0 ? ARROW_DOWN : ARROW_UP), ENTER]
}

/**
 * Keys, one per press, that get past the question on screen — or null when
 * none of the known startup questions is showing.
 */
export function startupPromptAnswer(screenLines: string[]): string[] | null {
    const claudeYes = screenLines.findIndex((line) => CLAUDE_TRUST_YES.test(line))
    if (claudeYes >= 0) return moveToAndConfirm(screenLines, claudeYes)

    if (screenLines.some((line) => CODEX_UPDATE.test(line)) && screenLines.some((line) => CODEX_UPDATE_SKIP.test(line))) {
        return [CODEX_SKIP_KEY]
    }

    if (screenLines.some((line) => CODEX_TRUST.test(line))) {
        const yes = screenLines.findIndex((line) => CODEX_TRUST_YES.test(line))
        if (yes >= 0) return moveToAndConfirm(screenLines, yes)
    }
    return null
}

/** The slice of an xterm Terminal the watcher reads. */
export interface PromptWatchTerminal {
    rows: number
    buffer: { active: { viewportY: number; getLine(row: number): { translateToString(trimRight?: boolean): string } | undefined } }
    onWriteParsed(listener: () => void): { dispose(): void }
}

/**
 * Agents draw a question before they read keys: arrows sent the moment the
 * dialog appeared were ignored on a real restore (2026-10-01). Answering once
 * the screen has been still this long worked.
 */
const SETTLE_MS = 1_500
/** Codex can ask twice in a row (update, then trust); a few retries on top. */
const MAX_ANSWERS = 5

function screenLines(term: PromptWatchTerminal): string[] {
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let row = 0; row < term.rows; row++) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    }
    return lines
}

/**
 * Watches a just-restored session and answers each known startup question once
 * the screen settles. Stops after STARTUP_PROMPT_WATCH_MS or MAX_ANSWERS
 * answers. Returns a stop function.
 */
export function watchStartupPrompts(term: PromptWatchTerminal, send: (key: string) => void): () => void {
    let done = false
    let answers = 0
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearTimeout(settleTimer)
        subscription.dispose()
    }
    const answerIfAsked = (): void => {
        if (done) return
        const keys = startupPromptAnswer(screenLines(term))
        if (!keys) return
        if (answers >= MAX_ANSWERS) {
            stop()
            return
        }
        answers++
        keys.forEach((key, index) => setTimeout(() => send(key), index * KEY_GAP_MS))
        // Look again after the keys went out, even if the program prints nothing.
        clearTimeout(settleTimer)
        settleTimer = setTimeout(answerIfAsked, keys.length * KEY_GAP_MS + SETTLE_MS)
    }
    // Every write restarts the quiet window; an answer goes out once it has been quiet.
    const subscription = term.onWriteParsed(() => {
        clearTimeout(settleTimer)
        settleTimer = setTimeout(answerIfAsked, SETTLE_MS)
    })
    const timer = setTimeout(stop, STARTUP_PROMPT_WATCH_MS)
    return stop
}
