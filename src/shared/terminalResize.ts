/**
 * Height changes that keep the bottom of the screen where it was.
 *
 * Used by both copies of every terminal — the renderer's xterm (TerminalView)
 * and the main-process mirror (TerminalMirror). They must resize the same way,
 * or the history a new window or a restart redraws from the mirror differs
 * from what the user saw.
 *
 * Why: agent TUIs drawn inline (Claude Code) answer SIGWINCH by going to the
 * top of the screen and rewriting every row with the tail of their own output;
 * the scrollback is left alone. xterm.js resizes the other way round when the
 * cursor is not on the last row — fewer rows drop rows at the bottom, more rows
 * add blank rows there. The repaint then lands on the wrong lines: shrinking
 * covered the first line of an answer, growing drew the banner and the prompt
 * a second time (recorded real session, T86; report 982d348d).
 *
 * What it does: when there is content below the cursor (an input box, a
 * footer), the resize is done as if the cursor sat on the last non-blank row.
 * Then xterm's own rules give what other terminals do (Alacritty, Ghostty,
 * Windows Terminal): rows leave from the top into the scrollback and come back
 * from it. Extra blank rows at the bottom still go first (one is kept: Claude
 * Code's frame ends in one), and when the screen ends in more than a couple of
 * blank rows growing pulls nothing down — the program's output is then
 * shorter than the screen, so what is in the scrollback is not its to repaint
 * (a restored-history marker survived only this way). The cursor goes back to
 * its own line afterwards.
 *
 * Left exactly as xterm does it: width-only changes, the alternate screen
 * (full-screen programs repaint everything), a scroll region, and a screen with
 * nothing but blank rows under the cursor (a shell prompt).
 *
 * Width changes are not helped: the program repaints only the screen, so a copy
 * at the old width stays in the scrollback in every terminal emulator
 * (term-research report §1).
 */

/** The public xterm.js surface this needs — met by both @xterm/xterm and @xterm/headless. */
export interface ResizableTerminal {
    readonly cols: number
    readonly rows: number
    readonly buffer: {
        readonly active: {
            readonly type: 'normal' | 'alternate'
            readonly baseY: number
            getLine(y: number): { translateToString(trimRight?: boolean): string } | undefined
        }
    }
    resize(cols: number, rows: number): void
}

/**
 * xterm's own buffer: the cursor row and the scroll region. Not public API —
 * the public buffer's cursor is read-only, and moving it with an escape
 * sequence would go to the back of the write queue, after output that has not
 * been parsed yet. Checked against @xterm/xterm and @xterm/headless 6.0.0
 * (Buffer.resize: rows below the cursor are dropped first, then the top scrolls
 * off; growing pulls from the scrollback only when the cursor is on the last row).
 */
interface CoreBuffer {
    y: number
    scrollTop: number
    scrollBottom: number
}

function coreBuffer(term: ResizableTerminal): CoreBuffer | null {
    const buffer = (term as unknown as { _core?: { buffer?: Partial<CoreBuffer> } })._core?.buffer
    if (!buffer || typeof buffer.y !== 'number' || typeof buffer.scrollTop !== 'number' || typeof buffer.scrollBottom !== 'number') {
        return null
    }
    return buffer as CoreBuffer
}

/** Blank rows at the bottom of the screen, counted up to (not including) the cursor row. */
function blankRowsAtBottom(term: ResizableTerminal, cursorRow: number): number {
    const buffer = term.buffer.active
    let blank = 0
    for (let row = term.rows - 1; row > cursorRow; row--) {
        if ((buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '').trim() !== '') break
        blank++
    }
    return blank
}

/**
 * Blank rows a screen may end in and still count as filled. Claude Code leaves
 * one blank row under its footer after a repaint and two after streaming an
 * answer (recorded sessions e4 · e6, 2.1.309). A program shorter than the
 * screen leaves far more.
 */
export const FILLED_SCREEN_BLANK_ROWS = 2

/**
 * Claude Code repaints `rows - 1` rows and keeps the last one blank, so that
 * blank row belongs to its frame: shrinking keeps it, and only blank rows above
 * it are dropped before the top scrolls off. Dropping it too lost one line per
 * shrink in the app (T87: the repaint started one line further down than the
 * screen had kept). A program that fills every row has no blank row to keep.
 */
const FRAME_BLANK_ROWS = 1

/**
 * The row the resize should treat as the cursor's, or null for xterm's own
 * behaviour. Exported for tests.
 */
export function anchorRowFor(term: ResizableTerminal, cursorRow: number, newRows: number): number | null {
    const lastRow = term.rows - 1
    const blank = blankRowsAtBottom(term, cursorRow)
    const contentBelowCursor = lastRow - cursorRow > blank
    if (!contentBelowCursor) return null
    if (newRows < term.rows) return lastRow - Math.max(0, blank - FRAME_BLANK_ROWS)
    // Growing: only a filled screen has the program's own lines above it to bring back.
    return blank <= FILLED_SCREEN_BLANK_ROWS ? lastRow : null
}

export function resizeKeepingBottom(term: ResizableTerminal, cols: number, rows: number): void {
    const core = coreBuffer(term)
    const plain =
        !core ||
        rows === term.rows ||
        term.buffer.active.type !== 'normal' ||
        core.scrollTop !== 0 ||
        core.scrollBottom !== term.rows - 1
    const anchorRow = plain ? null : anchorRowFor(term, core.y, rows)
    if (!core || anchorRow === null) {
        term.resize(cols, rows)
        return
    }
    const cursorAboveAnchor = anchorRow - core.y
    core.y = anchorRow
    term.resize(cols, rows)
    // xterm keeps the anchor row's line (clamped onto the new screen); the cursor goes back above it.
    const after = coreBuffer(term) ?? core
    after.y = Math.max(0, after.y - cursorAboveAnchor)
}
