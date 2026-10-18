import type { Terminal as HeadlessTerminal } from '@xterm/headless'
// Imported by file, not by package name: @xterm/headless 6.0.0 points its
// "module" field at lib/xterm.mjs, which the package does not ship, and
// electron-vite resolves "module" first. The file path is its real CommonJS
// build and gets bundled — it must be, because electron-builder.yml ships only
// an allowlist of node_modules, so a runtime require would crash the packaged app.
import { Terminal } from '@xterm/headless/lib-headless/xterm-headless.js'
// Same reason as above: bundled by file so the packaged app does not need it in node_modules.
import { SerializeAddon } from '@xterm/addon-serialize/lib/addon-serialize.js'
import { TerminalManager } from './TerminalManager'

/**
 * Keeps a headless xterm copy of every terminal in the main process.
 *
 * Two readers depend on it:
 *  - the Control API, so an AI can read the screen the way the user sees it;
 *  - terminal history. The renderer's xterm dies with the renderer (a crash
 *    under memory pressure, a closed window) while the ptys live on, so a new
 *    window redraws from here instead of starting blank. Snapshots written to
 *    disk from here also bring history back after a force-quit.
 *
 * Why a terminal emulator instead of the raw output: agent CLIs are TUIs that
 * redraw in place with cursor movement. Stripping escape codes from the byte
 * stream yields every intermediate frame glued together; replaying it through
 * an emulator yields the final screen.
 *
 * Every terminal gets a mirror from the moment its pty starts, because a mirror
 * only knows what was printed after it was attached. Asking the program to
 * repaint instead would send SIGWINCH, which leaves repaint debris in the
 * user's scrollback.
 */

/** Pty size before the renderer reports the real one. Matches TerminalView's fallback. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 30

/**
 * How much history a mirror keeps — and so what a new window or a restart can
 * bring back. Also the most `read_output --tail` can return.
 * Measured 2026-10-13 (fully-filled mirror): heap 0.86MB plus the line buffers,
 * which scale with width — RSS ~2.5MB at 80 columns, ~8MB at 200.
 */
const MIRROR_SCROLLBACK = 2000

/**
 * Agent CLIs print this while a turn is in progress — Claude Code
 * ("esc to interrupt") and Codex ("Esc to interrupt") both do. Output alone is
 * not enough: a model can think for a while without the screen changing much.
 */
const BUSY_PATTERN = /esc to interrupt/i

/**
 * A question the agent cannot get past without an answer: permission prompts,
 * folder-trust checks and selection menus. Read from the screen so it works
 * without hooks. Typing a prompt into one of these is dangerous — Enter picks
 * whatever option is highlighted — so the API refuses text while one is shown.
 *
 * Checked against Claude Code 2.1 (trust dialog: "Yes, I trust this folder",
 * footer "Enter to confirm · Esc to cancel") and Codex approval prompts. Codex
 * asks about a new folder in its own words ("Do you trust the contents of this
 * directory?" … "Press enter to continue"); missing it once let a first prompt
 * be typed into that dialog and vanish while the API reported it sent.
 */
const AWAITING_INPUT_PATTERNS = [
    /Enter to confirm/i,
    /Esc to cancel/i,
    /trust this folder/i,
    /Do you trust the contents of this directory/i,
    /Press enter to continue/i,
    /Do you want to (proceed|make|create|allow|run)/i,
    /No, and tell Claude what to do differently/,
    /Would you like to (run|make|apply)/i,
    /\bYes, proceed\b/i
]

/** Parsing normally finishes in milliseconds; this only guards against a disposed mirror. */
const FLUSH_TIMEOUT_MS = 1000

/** Erase in Display (CSI Ps J) with Ps = 3 deletes the scrollback, not just the screen. */
const ERASE_SCROLLBACK_PARAM = 3

/** Agent dialogs put the question a few lines above the options at the bottom. */
const QUESTION_REGION_LINES = 15

/**
 * Claude Code draws its input box between two full-width rules. Matched on the
 * trimmed row, so a rule with a label inside it does not count.
 */
const INPUT_BOX_RULE = /^─{20,}$/

/** What an agent's input box currently holds, split by how it is drawn. */
export interface InputBox {
    /** Text drawn normally — what was typed (by the user or the API). */
    typed: string
    /** Text drawn dim — the agent's suggestion for the next prompt, never typed by anyone. */
    suggestion: string
}

interface Mirror {
    term: HeadlessTerminal
    serializer: SerializeAddon
    lastOutputAt: number
    exited: boolean
    /** Attached to a pty that was already running, so earlier output is missing. */
    partial: boolean
}

export interface SnapshotOptions {
    /**
     * For a pty that no longer exists: drop terminal modes and the alternate
     * screen, which describe a program that will not be there to use them.
     */
    forDisk?: boolean
}

/**
 * Escape sequences that redraw a terminal, and the size they were taken at.
 * Replay them at that size: on a terminal with more or fewer rows, lines that
 * were in scrollback land on screen (or the reverse), and the next agent
 * repaint erases whatever is on screen.
 */
export interface TerminalSnapshot {
    data: string
    cols: number
    rows: number
}

export class TerminalMirror {
    private readonly mirrors = new Map<string, Mirror>()

    /**
     * The program in a terminal deleted its scrollback (CSI 3 J). Read from the
     * mirror's parser rather than the raw stream, so a sequence split across
     * two pty chunks is still seen. The default handler still runs.
     */
    public onScrollbackErased?: (id: string) => void

    constructor(private readonly terminals: TerminalManager) {
        terminals.events.on('created', (id, cols, rows) => {
            // Runs before the new pty's first output is delivered, so a mirror
            // attached here sees everything.
            this.attach(id)
            const mirror = this.mirrors.get(id)
            if (!mirror) return
            mirror.exited = false
            mirror.partial = false
            this.resize(mirror, cols, rows)
        })
        terminals.events.on('resized', (id, cols, rows) => {
            const mirror = this.mirrors.get(id)
            if (mirror) this.resize(mirror, cols, rows)
        })
        terminals.events.on('output', (id, data) => {
            const mirror = this.mirrors.get(id)
            if (!mirror) return
            mirror.term.write(data)
            mirror.lastOutputAt = Date.now()
        })
        terminals.events.on('exited', (id) => {
            const mirror = this.mirrors.get(id)
            if (mirror) mirror.exited = true
        })
    }

    /** Start mirroring. Call before the pty exists to capture everything it prints. */
    attach(id: string, size?: { cols: number; rows: number }): void {
        if (this.mirrors.has(id)) return
        const initial = size ?? this.terminals.getSize(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
        const term = new Terminal({
            cols: initial.cols,
            rows: initial.rows,
            scrollback: MIRROR_SCROLLBACK,
            // Same as the renderer's xterm (TerminalView): a full clear pushes the
            // screen into scrollback instead of erasing it. Without it the two
            // copies of history drift apart on every CLI repaint.
            scrollOnEraseInDisplay: true,
            allowProposedApi: true
        })
        const serializer = new SerializeAddon()
        term.loadAddon(serializer)
        term.parser.registerCsiHandler({ final: 'J' }, (params) => {
            if (params[0] === ERASE_SCROLLBACK_PARAM) this.onScrollbackErased?.(id)
            return false
        })
        this.mirrors.set(id, { term, serializer, lastOutputAt: 0, exited: false, partial: this.terminals.hasTerminal(id) })
    }

    /**
     * Lays history from a previous run into a fresh mirror, followed by a
     * marker line, before the new pty prints anything. Resolves once both are
     * parsed — the caller must not start the pty earlier, or its first output
     * would land above the marker.
     *
     * The restored lines and the marker end up in scrollback, with the screen
     * left empty. Agent TUIs (Claude Code) repaint by erasing every row on
     * screen — measured with a real `claude --resume`: restored lines still
     * on screen and the marker were wiped on the first repaint.
     */
    seed(id: string, size: { cols: number; rows: number }, history: string, marker: string): Promise<void> {
        this.attach(id, size)
        const mirror = this.mirrors.get(id)
        if (!mirror) return Promise.resolve()
        return new Promise((resolve) => {
            mirror.term.write(history, () => {
                // The saved cursor may sit inside the old screen (an agent's
                // input box); writing the marker there would overwrite it.
                // A full clear (with scrollOnEraseInDisplay) moves everything into scrollback.
                mirror.term.write(cursorBelowContent(mirror.term) + marker + '\x1b[2J\x1b[H', () => resolve())
            })
        })
    }

    /**
     * The terminal's history and screen as escape sequences that redraw it.
     * Serialized inside a write callback, so the result holds exactly the
     * output written before this call — the caller can hold back later output
     * and send it after the snapshot without gaps or repeats.
     */
    snapshot(id: string, options: SnapshotOptions = {}): Promise<TerminalSnapshot | null> {
        const mirror = this.mirrors.get(id)
        if (!mirror) return Promise.resolve(null)
        const serialize = (): TerminalSnapshot => ({
            data: mirror.serializer.serialize({
                scrollback: MIRROR_SCROLLBACK,
                excludeModes: options.forDisk,
                excludeAltBuffer: options.forDisk
            }),
            cols: mirror.term.cols,
            rows: mirror.term.rows
        })
        return new Promise((resolve) => {
            // A mirror disposed mid-flush never calls back; serialize what it has.
            const timer = setTimeout(() => resolve(this.mirrors.has(id) ? serialize() : null), FLUSH_TIMEOUT_MS)
            mirror.term.write('', () => {
                clearTimeout(timer)
                resolve(serialize())
            })
        })
    }

    /** Cmd+K cleared the terminal on screen; history must not bring it back. */
    clear(id: string): void {
        this.mirrors.get(id)?.term.clear()
    }

    /** True when output printed before the mirror was attached is missing from it. */
    isPartial(id: string): boolean {
        return this.mirrors.get(id)?.partial ?? false
    }

    detach(id: string): void {
        const mirror = this.mirrors.get(id)
        if (!mirror) return
        mirror.term.dispose()
        this.mirrors.delete(id)
    }

    has(id: string): boolean {
        return this.mirrors.has(id)
    }

    lastOutputAt(id: string): number {
        return this.mirrors.get(id)?.lastOutputAt ?? 0
    }

    hasExited(id: string): boolean {
        return this.mirrors.get(id)?.exited ?? false
    }

    /** The program asked for bracketed paste, so multi-line text can be sent as one paste. */
    bracketedPaste(id: string): boolean {
        return this.mirrors.get(id)?.term.modes.bracketedPasteMode ?? false
    }

    /** The visible screen, one string per row, trailing blank rows dropped. */
    screen(id: string): string[] {
        const mirror = this.mirrors.get(id)
        if (!mirror) return []
        const buffer = mirror.term.buffer.active
        const lines: string[] = []
        for (let row = 0; row < mirror.term.rows; row++) {
            lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? '')
        }
        return trimTrailingBlank(lines)
    }

    /** The last `count` lines of scrollback plus screen, trailing blank rows dropped. */
    tail(id: string, count: number): string[] {
        const mirror = this.mirrors.get(id)
        if (!mirror) return []
        const buffer = mirror.term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < buffer.length; i++) {
            lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
        }
        return trimTrailingBlank(lines).slice(-count)
    }

    /**
     * Like `tail`, but a line the terminal wrapped is joined back into one, so
     * text split by the wrap stays whole. A program that breaks rows itself
     * (zsh's line editor does for a long typed command) leaves no wrap flag;
     * the feedback masker deals with those cuts (maskSecrets).
     */
    logicalTail(id: string, count: number): string[] {
        const mirror = this.mirrors.get(id)
        if (!mirror) return []
        const buffer = mirror.term.buffer.active
        const lines: string[] = []
        for (let i = 0; i < buffer.length; i++) {
            const line = buffer.getLine(i)
            // Untrimmed: a row that wraps is full, and trimming it would drop a space at the wrap.
            const text = line?.translateToString(false) ?? ''
            if (line?.isWrapped && lines.length > 0) lines[lines.length - 1] += text
            else lines.push(text)
        }
        return trimTrailingBlank(lines.map((text) => text.trimEnd())).slice(-count)
    }

    /** Lines in history plus screen. */
    lineCount(id: string): number {
        return this.mirrors.get(id)?.term.buffer.active.length ?? 0
    }

    size(id: string): { cols: number; rows: number } | null {
        const mirror = this.mirrors.get(id)
        return mirror ? { cols: mirror.term.cols, rows: mirror.term.rows } : null
    }

    /**
     * The input box at the bottom of the screen (the rows between the last two
     * rules), or null when the program draws none. Dim cells are reported
     * separately: Claude Code shows its next-prompt suggestion there in dim
     * text, and plain text alone cannot tell it from something a person typed.
     */
    inputBox(id: string): InputBox | null {
        const mirror = this.mirrors.get(id)
        if (!mirror) return null
        const buffer = mirror.term.buffer.active
        const rules: number[] = []
        for (let row = mirror.term.rows - 1; row >= 0 && rules.length < 2; row--) {
            const text = buffer.getLine(buffer.viewportY + row)?.translateToString(true).trim() ?? ''
            if (INPUT_BOX_RULE.test(text)) rules.push(row)
        }
        if (rules.length < 2) return null

        const [bottom, top] = rules
        const typed: string[] = []
        const suggestion: string[] = []
        const cell = buffer.getNullCell()
        for (let row = top + 1; row < bottom; row++) {
            const line = buffer.getLine(buffer.viewportY + row)
            if (!line) continue
            let typedRow = ''
            let suggestionRow = ''
            for (let col = 0; col < line.length; col++) {
                line.getCell(col, cell)
                // Wide characters occupy a second, empty cell.
                if (cell.getWidth() === 0) continue
                const chars = cell.getChars()
                // Claude Code draws the spaces inside dim text without the dim
                // attribute (seen replaying a real session), so blanks belong to both.
                if (chars.trim() === '') {
                    typedRow += ' '
                    suggestionRow += ' '
                } else if (cell.isDim()) {
                    suggestionRow += chars
                } else {
                    typedRow += chars
                }
            }
            typed.push(collapseSpaces(typedRow))
            suggestion.push(collapseSpaces(suggestionRow))
        }
        return {
            typed: stripPromptGlyph(typed.filter(Boolean).join(' ')),
            suggestion: suggestion.filter(Boolean).join(' ')
        }
    }

    /** The screen currently shows an agent turn in progress. */
    showsBusy(id: string): boolean {
        return this.screen(id).some((line) => BUSY_PATTERN.test(line))
    }

    /**
     * The screen currently shows a prompt only a human (or the driving AI) can
     * answer. Only the bottom of the screen counts: an open question sits where
     * the input would be, while one that was already answered and scrolled up
     * is history.
     */
    showsAwaitingInput(id: string): boolean {
        const text = this.screen(id)
            .filter((line) => line.trim() !== '')
            .slice(-QUESTION_REGION_LINES)
            .join('\n')
        return AWAITING_INPUT_PATTERNS.some((pattern) => pattern.test(text))
    }

    /**
     * Resolves once everything written so far has been parsed. xterm parses
     * asynchronously, so reading right after output arrives can miss the tail.
     */
    flush(id: string): Promise<void> {
        const mirror = this.mirrors.get(id)
        if (!mirror) return Promise.resolve()
        // Bounded: a mirror disposed mid-flush (user clicked Disconnect AI
        // during a wait) never calls back, and a wait must not hang on it.
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, FLUSH_TIMEOUT_MS)
            mirror.term.write('', () => {
                clearTimeout(timer)
                resolve()
            })
        })
    }

    disposeAll(): void {
        for (const id of [...this.mirrors.keys()]) this.detach(id)
    }

    private resize(mirror: Mirror, cols: number, rows: number): void {
        if (cols > 0 && rows > 0 && (mirror.term.cols !== cols || mirror.term.rows !== rows)) {
            mirror.term.resize(cols, rows)
        }
    }
}

/**
 * Moves the cursor to the start of the line after the last non-blank row on
 * screen (the top row when the screen is blank).
 */
function cursorBelowContent(term: HeadlessTerminal): string {
    const buffer = term.buffer.active
    let lastRow = -1
    for (let row = term.rows - 1; row >= 0; row--) {
        if ((buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').trim() !== '') {
            lastRow = row
            break
        }
    }
    // CSI row;col H is 1-based; \r\n from the last row scrolls instead of overwriting.
    return lastRow < 0 ? '\x1b[0m\x1b[1;1H' : `\x1b[0m\x1b[${lastRow + 1};1H\r\n`
}

function collapseSpaces(text: string): string {
    return text.replace(/\s+/g, ' ').trim()
}

/** The box starts with a prompt glyph ("❯" or ">"); it is decoration, not input. */
function stripPromptGlyph(text: string): string {
    return text.replace(/^[❯>]\s*/, '').trim()
}

function trimTrailingBlank(lines: string[]): string[] {
    let end = lines.length
    while (end > 0 && lines[end - 1].trim() === '') end--
    return lines.slice(0, end)
}
