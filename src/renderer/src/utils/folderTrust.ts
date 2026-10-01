/**
 * Claude Code asks "Is this a project you created or one you trust?" before it
 * starts in a folder it has no trust record for. It never records one for the
 * home directory, so a session restored there asks on every launch. The cursor
 * starts on "No, exit": the restored agent sits on that question, and a stray
 * Enter quits it (seen 2026-10-01, Claude Code 2.1.286).
 *
 * A restored session resumes a conversation Claude Code already ran in that
 * folder, so the folder was trusted once — answering Yes again only gives back
 * what the restart took away.
 */

const TRUST_YES = /Yes, I trust this folder/
/** The highlighted option starts with a pointer glyph. */
const OPTION_CURSOR = /^\s*[❯›>]\s/
/** Rows above or below "Yes" where the highlighted option can be. */
const OPTION_WINDOW = 3
const ARROW_DOWN = '\x1b[B'
const ARROW_UP = '\x1b[A'
const ENTER = '\r'

/** How long after a resume the question may still appear. Claude Code takes seconds to start under load. */
export const FOLDER_TRUST_WATCH_MS = 60_000

/**
 * Gap between key presses. Sent as one write, "arrow + Enter" reached Claude
 * Code as a single chunk and was ignored — the real dialog stayed on "No, exit"
 * while the mock accepted it (2026-10-01). Separate writes are read as keys.
 */
const KEY_GAP_MS = 120

/**
 * Keys, one per press, that move the cursor from where it is to "Yes, I trust
 * this folder" and confirm — or null when the screen does not show that
 * question. The options carry no numbers, so the answer is arrows for the
 * distance between the two rows.
 */
export function folderTrustAnswer(screenLines: string[]): string[] | null {
    const yes = screenLines.findIndex((line) => TRUST_YES.test(line))
    if (yes < 0) return null
    // The highlighted option is the pointer row nearest to "Yes": the agent's
    // own input prompt ("❯ …") can sit a few rows above and must not win.
    let cursor = -1
    for (let distance = 0; distance <= OPTION_WINDOW && cursor < 0; distance++) {
        for (const row of [yes - distance, yes + distance]) {
            if (row >= 0 && row < screenLines.length && OPTION_CURSOR.test(screenLines[row])) {
                cursor = row
                break
            }
        }
    }
    if (cursor < 0) return null
    const distance = yes - cursor
    return [...Array<string>(Math.abs(distance)).fill(distance > 0 ? ARROW_DOWN : ARROW_UP), ENTER]
}

/** The slice of an xterm Terminal the watcher reads. */
export interface TrustWatchTerminal {
    rows: number
    buffer: { active: { viewportY: number; getLine(row: number): { translateToString(trimRight?: boolean): string } | undefined } }
    onWriteParsed(listener: () => void): { dispose(): void }
}

/**
 * Claude Code draws the question before it reads keys: arrows sent the moment
 * the dialog appeared were ignored on a real restore (2026-10-01). Answering
 * once the screen has been still this long worked; so did the skill, which
 * answers after the app's 2s start-up quiet window.
 */
const SETTLE_MS = 1_500
/** If the question is still there after answering, try again — at most this many times. */
const MAX_ATTEMPTS = 3

function screenLines(term: TrustWatchTerminal): string[] {
    const buffer = term.buffer.active
    const lines: string[] = []
    for (let row = 0; row < term.rows; row++) {
        lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
    }
    return lines
}

/**
 * Watches a just-restored session for the trust question and answers it once
 * the screen settles. Stops when the question is gone after an answer, after
 * MAX_ATTEMPTS answers, or after FOLDER_TRUST_WATCH_MS. Returns a stop function.
 */
export function watchForFolderTrust(term: TrustWatchTerminal, send: (key: string) => void): () => void {
    let done = false
    let attempts = 0
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearTimeout(settleTimer)
        subscription.dispose()
    }
    const answerIfStillAsked = (): void => {
        if (done) return
        const keys = folderTrustAnswer(screenLines(term))
        if (!keys) {
            // Answered (or never asked): nothing left to do once we have tried.
            if (attempts > 0) stop()
            return
        }
        if (attempts >= MAX_ATTEMPTS) {
            stop()
            return
        }
        attempts++
        keys.forEach((key, index) => setTimeout(() => send(key), index * KEY_GAP_MS))
        // Check again after the keys went out, even if the program prints nothing.
        clearTimeout(settleTimer)
        settleTimer = setTimeout(answerIfStillAsked, keys.length * KEY_GAP_MS + SETTLE_MS)
    }
    // Every write restarts the quiet window; the answer goes out once it has been quiet.
    const subscription = term.onWriteParsed(() => {
        clearTimeout(settleTimer)
        settleTimer = setTimeout(answerIfStillAsked, SETTLE_MS)
    })
    const timer = setTimeout(stop, FOLDER_TRUST_WATCH_MS)
    return stop
}
