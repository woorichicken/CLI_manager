import type { Terminal as HeadlessTerminal } from '@xterm/headless'
// Imported by file, not by package name: @xterm/headless 6.0.0 points its
// "module" field at lib/xterm.mjs, which the package does not ship, and
// electron-vite resolves "module" first. The file path is its real CommonJS
// build and gets bundled — it must be, because electron-builder.yml ships only
// an allowlist of node_modules, so a runtime require would crash the packaged app.
import { Terminal } from '@xterm/headless/lib-headless/xterm-headless.js'
import { TerminalManager } from './TerminalManager'

/**
 * Keeps a headless xterm copy of the terminals the Control API drives, so an
 * AI can read the screen the way the user sees it.
 *
 * Why a terminal emulator instead of the raw output: agent CLIs are TUIs that
 * redraw in place with cursor movement. Stripping escape codes from the byte
 * stream yields every intermediate frame glued together; replaying it through
 * an emulator yields the final screen.
 *
 * While the Control API is on, every terminal gets a mirror from the moment
 * its pty starts, because the API may read any session and a mirror only knows
 * what was printed after it was attached. Asking the program to repaint instead
 * would send SIGWINCH, which leaves repaint debris in the user's scrollback.
 * While the API is off there are no mirrors, so the cost is zero.
 */

/** Pty size before the renderer reports the real one. Matches TerminalView's fallback. */
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 30

/**
 * Matches the most `read_output --tail` can return (2000 lines): history beyond
 * that is unreachable, so keeping it would be memory nobody can read.
 * Measured 2026-09-23: ~0.8MB per fully-filled mirror.
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
    lastOutputAt: number
    exited: boolean
    /** Attached to a pty that was already running, so earlier output is missing. */
    partial: boolean
}

export class TerminalMirror {
    private readonly mirrors = new Map<string, Mirror>()
    private mirrorAll = false

    constructor(private readonly terminals: TerminalManager) {
        terminals.events.on('created', (id, cols, rows) => {
            // Runs before the new pty's first output is delivered, so a mirror
            // attached here sees everything.
            if (this.mirrorAll) this.attach(id)
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
    attach(id: string): void {
        if (this.mirrors.has(id)) return
        const size = this.terminals.getSize(id) ?? { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
        const term = new Terminal({
            cols: size.cols,
            rows: size.rows,
            scrollback: MIRROR_SCROLLBACK,
            allowProposedApi: true
        })
        this.mirrors.set(id, { term, lastOutputAt: 0, exited: false, partial: this.terminals.hasTerminal(id) })
    }

    /**
     * Mirror every terminal, present and future. Terminals that are already
     * running start with an empty mirror and are reported as partial.
     */
    setMirrorAll(enabled: boolean): void {
        this.mirrorAll = enabled
        if (enabled) for (const id of this.terminals.listTerminalIds()) this.attach(id)
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
