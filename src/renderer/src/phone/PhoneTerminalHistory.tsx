import { useEffect, useMemo, useRef, useState } from 'react'
import type { FoldLine } from './terminalFold'
import { gridRowHtml, historyRowCount } from './terminalHistory'
import { FONT, FONT_SIZE, TERMINAL_THEME, type PhoneTerminalHandle } from './usePhoneTerminal'

/**
 * The Mac's history drawn in the room above its screen (terminalHistory.ts says why): the rows just
 * above the grid's top, at the grid's cell size and scale, so the phone shows lines instead of an
 * empty top. Read only — it follows the grid (new output, a history drag) and takes no input of
 * its own; a drag on it moves the history as a drag on the grid does.
 */

interface HistoryLine {
    row: number
    html: string
}

/** the bundled font's advance, so a row of text lands on the grid's cells */
function charWidth(): number {
    try {
        const context = document.createElement('canvas').getContext('2d')
        if (!context) return 0
        context.font = `${FONT_SIZE}px ${FONT}`
        return context.measureText('W').width
    } catch {
        return 0
    }
}

export function PhoneTerminalHistory({
    term,
    natural,
    scale,
    room
}: {
    term: PhoneTerminalHandle
    natural: { width: number; height: number }
    scale: number
    room: number
}) {
    const handle = useRef(term)
    handle.current = term
    const { subscribe, size, fontVersion } = term
    const rows = size?.rows ?? 0
    const cols = size?.cols ?? 0
    const [lines, setLines] = useState<HistoryLine[]>([])

    useEffect(() => {
        const read = (): void => {
            const xterm = handle.current.terminal()
            if (!xterm || rows <= 0) {
                setLines([])
                return
            }
            const buffer = xterm.buffer.active
            const count = historyRowCount(room, natural.height, rows, scale, buffer.viewportY)
            const next: HistoryLine[] = []
            for (let row = buffer.viewportY - count; row < buffer.viewportY; row++) {
                const line = buffer.getLine(row) as FoldLine | undefined
                next.push({ row, html: line ? gridRowHtml(line, xterm.cols, TERMINAL_THEME).html : '' })
            }
            setLines((previous) =>
                previous.length === next.length && previous.every((line, index) => line.row === next[index].row && line.html === next[index].html) ? previous : next
            )
        }
        read()
        return subscribe(read)
    }, [subscribe, room, natural.height, rows, scale])

    // measured again when the bundled font arrives (fontVersion bumps)
    const advance = useMemo(() => (fontVersion >= 0 ? charWidth() : 0), [fontVersion])
    if (lines.length === 0 || rows <= 0 || cols <= 0) return null
    const cellHeight = natural.height / rows
    const cellWidth = natural.width / cols
    const letterSpacing = advance > 0 ? cellWidth - advance : 0

    return (
        <div
            className="phone-term-history"
            data-testid="phone-terminal-history"
            data-rows={lines.length}
            aria-hidden="true"
            style={{ width: natural.width * scale, height: lines.length * cellHeight * scale }}
        >
            <div
                className="phone-term-history-rows"
                style={{
                    width: natural.width,
                    transform: `scale(${scale})`,
                    fontFamily: FONT,
                    fontSize: FONT_SIZE,
                    lineHeight: `${cellHeight}px`,
                    letterSpacing: `${letterSpacing}px`
                }}
            >
                {lines.map((line) => (
                    <div
                        key={line.row}
                        className="phone-term-history-row"
                        data-row={line.row}
                        style={{ height: cellHeight }}
                        // built from the buffer's characters, escaped in terminalHistory.ts
                        dangerouslySetInnerHTML={{ __html: line.html }}
                    />
                ))}
            </div>
        </div>
    )
}
