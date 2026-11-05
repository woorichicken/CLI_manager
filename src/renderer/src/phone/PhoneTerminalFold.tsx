import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { foldRows, type FoldedLine, type FoldLine } from './terminalFold'
import { TERMINAL_THEME, type PhoneTerminalHandle } from './usePhoneTerminal'

/**
 * «Wrap to screen»: the Mac's screen drawn again as text at the phone's width and the
 * terminal's own 13px (terminalFold.ts says why and how). The grid under it is unchanged and
 * still takes the input; this view only reads it. It follows the end while you are at the end;
 * scrolled up, it stays. A drag past its top (or bottom) moves the Mac's history, as the grid's
 * own drag does.
 */

const FOLD_THEME = { ...TERMINAL_THEME }
/** one history step per this many pixels dragged past an edge */
const HISTORY_STEP_PX = 18
/** this close to the end counts as "at the end" — new output keeps it there */
const STICK_PX = 24

interface CursorState {
    readonly isCursorHidden?: boolean
}

/** xterm keeps DECTCEM (cursor shown or not) on a private service; a hidden cursor draws no block */
function cursorHidden(term: NonNullable<ReturnType<PhoneTerminalHandle['terminal']>>): boolean {
    const core = (term as unknown as { _core?: { coreService?: CursorState } })._core
    return core?.coreService?.isCursorHidden ?? false
}

export function PhoneTerminalFold({ term }: { term: PhoneTerminalHandle }) {
    const view = useRef<HTMLDivElement>(null)
    const [lines, setLines] = useState<FoldedLine[]>([])
    const stick = useRef(true)
    const drag = useRef<{ y: number } | null>(null)
    // the handle is a new object every render; what it reaches is not
    const handle = useRef(term)
    handle.current = term
    const { subscribe } = term

    useEffect(() => {
        const draw = (): void => {
            const xterm = handle.current.terminal()
            if (!xterm) return
            const element = view.current
            if (element) stick.current = element.scrollTop + element.clientHeight >= element.scrollHeight - STICK_PX
            const buffer = xterm.buffer.active
            const cursor = cursorHidden(xterm) ? null : { row: buffer.baseY + buffer.cursorY, col: buffer.cursorX }
            setLines(foldRows((row) => buffer.getLine(row) as FoldLine | undefined, buffer.viewportY, xterm.rows, xterm.cols, FOLD_THEME, cursor))
        }
        draw()
        return subscribe(draw)
    }, [subscribe])

    // at the end before this draw: stay at the end after it
    useLayoutEffect(() => {
        const element = view.current
        if (element && stick.current) element.scrollTop = element.scrollHeight
    }, [lines])

    const onTouchStart = (event: React.TouchEvent): void => {
        drag.current = event.touches.length === 1 ? { y: event.touches[0].clientY } : null
    }
    const onTouchMove = (event: React.TouchEvent): void => {
        const element = view.current
        const start = drag.current
        if (!element || !start || event.touches.length !== 1) return
        const dy = event.touches[0].clientY - start.y
        const atTop = element.scrollTop <= 0
        const atEnd = element.scrollTop + element.clientHeight >= element.scrollHeight - 1
        // past the top: older lines of the Mac's history; past the end: back toward the live screen
        if ((dy > 0 && atTop) || (dy < 0 && atEnd)) {
            const steps = Math.trunc(dy / HISTORY_STEP_PX)
            if (steps !== 0) {
                term.scrollLines(-steps)
                drag.current = { y: event.touches[0].clientY }
            }
        } else {
            drag.current = { y: event.touches[0].clientY }
        }
    }

    return (
        <div
            ref={view}
            className="phone-fold"
            data-testid="phone-terminal-fold"
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={() => (drag.current = null)}
        >
            {lines.map((line, index) => (
                <div
                    key={index}
                    className="phone-fold-line"
                    data-rule={line.rule ? '' : undefined}
                    data-cursor={line.cursor ? '' : undefined}
                    // the html is built from the buffer's characters, escaped in terminalFold.ts
                    dangerouslySetInnerHTML={{ __html: line.html || '​' }}
                />
            ))}
        </div>
    )
}
