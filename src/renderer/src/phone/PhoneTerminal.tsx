import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownToLine, ChevronsDown, ChevronsUp, Eye, Keyboard, Maximize2, Minus, Plus, Send, WrapText } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { PhoneRole } from '../../../shared/phone'
import { KEY_BAR_ITEMS, controlCharacter, createKeyRepeat, isRepeatable, keyBarLabel, keySequence, type KeyBarItem } from './keyBar'
import { PhoneTerminalFold } from './PhoneTerminalFold'
import { readWrap, saveWrap } from './terminalFold'
import { usePhoneTerminal } from './usePhoneTerminal'

/**
 * The Mac terminal on the phone. Drawn at the Mac's size (e.g. 111×43) and shrunk to the
 * phone's width; pinch or +/− to zoom, then drag sideways. The Mac's pty never changes
 * size for the phone — there is no message for it.
 *
 * View (default) only watches. Type shows the key bar (Esc · Tab · Ctrl · arrows · ^C · ⏎)
 * and an input line edited before it is sent — only for this Mac's owner or a device
 * paired with "Can type".
 */

const MAX_SCALE = 2
/** between the text and the Enter of an input line, as the Control API spaces them */
const ENTER_GAP_MS = 60
/**
 * The zoom this phone last chose (−/+/pinch), kept in its own browser storage so each device
 * remembers its own; absent means "fit the width", the default. Only remembered — what the
 * default should be is still open (report-r2 of impl-phone).
 */
const ZOOM_KEY = 'phone-terminal-zoom'

function readZoom(): number | null {
    try {
        const saved = Number(window.localStorage.getItem(ZOOM_KEY))
        return Number.isFinite(saved) && saved > 0 ? Math.min(MAX_SCALE, saved) : null
    } catch {
        return null
    }
}

function saveZoom(zoom: number | null): void {
    try {
        if (zoom === null) window.localStorage.removeItem(ZOOM_KEY)
        else window.localStorage.setItem(ZOOM_KEY, String(zoom))
    } catch {
        // storage blocked: the zoom just is not remembered
    }
}

export function PhoneTerminal({ sessionId, deviceRole }: { sessionId: string; deviceRole: PhoneRole }) {
    const host = useRef<HTMLDivElement>(null)
    const scroller = useRef<HTMLDivElement>(null)
    const term = usePhoneTerminal(sessionId, host)
    const termHandle = useRef(term)
    termHandle.current = term
    const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
    const [fitWidth, setFitWidth] = useState(0)
    const [zoom, setZoom] = useState<number | null>(readZoom) // null: fit the width
    // «Wrap to screen» (terminalFold.ts): this phone's choice, off by default — fit stays the default view
    const [wrap, setWrap] = useState(readWrap)
    const [typing, setTyping] = useState(false)
    const [ctrl, setCtrl] = useState(false)
    const [line, setLine] = useState('')
    const pinch = useRef<{ distance: number; scale: number } | null>(null)
    const swipe = useRef<{ y: number } | null>(null)

    const canType = deviceRole === 'drive' && term.role !== 'watch'

    // the drawn terminal's own size, unscaled (offsetWidth ignores transforms)
    useLayoutEffect(() => {
        const measure = (): void => {
            const screen = host.current?.querySelector<HTMLElement>('.xterm-screen')
            if (screen && screen.offsetWidth > 0) setNatural({ width: screen.offsetWidth, height: screen.offsetHeight })
        }
        measure()
        // xterm lays out a resize on its next frame
        const frame = window.requestAnimationFrame(measure)
        return () => window.cancelAnimationFrame(frame)
    }, [term.size, term.status])

    useEffect(() => {
        const element = scroller.current
        if (!element) return
        const observer = new ResizeObserver(() => setFitWidth(element.clientWidth))
        observer.observe(element)
        setFitWidth(element.clientWidth)
        return () => observer.disconnect()
    }, [])

    useEffect(() => saveZoom(zoom), [zoom])
    useEffect(() => saveWrap(wrap), [wrap])

    const fitScale = natural && fitWidth > 0 ? Math.min(1, fitWidth / natural.width) : 1
    // a zoom remembered on a narrower screen (portrait, then turned) never shows less than the width
    const scale = zoom === null ? fitScale : Math.max(fitScale, zoom)

    // Zoomed past the width, the screen is wider than the phone: when the Mac's cursor moves (typing,
    // a menu's highlight), bring it into sight — ovis keeps the cursor row in view the same way
    // (useTerminalMount.ts follow). A pan of your own stays until the cursor moves again.
    const lastCursor = useRef('')
    const { subscribe } = term
    const followRef = useRef({ scale, natural, zoomed: false })
    followRef.current = { scale, natural, zoomed: zoom !== null && scale > fitScale + 0.001 && !wrap }
    useEffect(() => {
        return subscribe(() => {
            const { scale: current, natural: size, zoomed } = followRef.current
            const xterm = termHandle.current.terminal()
            const element = scroller.current
            if (!zoomed || !xterm || !size || !element) return
            const buffer = xterm.buffer.active
            if (buffer.viewportY !== buffer.baseY) return // reading history: leave it
            const key = `${buffer.cursorX},${buffer.cursorY}`
            if (key === lastCursor.current) return
            lastCursor.current = key
            const cellWidth = (size.width / xterm.cols) * current
            const cellHeight = (size.height / xterm.rows) * current
            const x = buffer.cursorX * cellWidth
            const y = buffer.cursorY * cellHeight
            const margin = cellWidth * 4
            if (x < element.scrollLeft + margin || x + cellWidth > element.scrollLeft + element.clientWidth - margin) {
                element.scrollLeft = Math.max(0, x - element.clientWidth / 3)
            }
            if (y < element.scrollTop || y + cellHeight > element.scrollTop + element.clientHeight) {
                element.scrollTop = Math.max(0, y - element.clientHeight / 2)
            }
        })
    }, [subscribe])

    const sendKey = useCallback((item: KeyBarItem) => {
        if (item.type === 'modifier') {
            setCtrl((held) => !held)
            return
        }
        term.send(keySequence(item.key, term.applicationCursorKeys(), ctrl))
        setCtrl(false)
    }, [term, ctrl])

    const sendLine = useCallback(() => {
        const text = line
        if (text) term.send(text)
        // the program sees the text land before its Enter, as typed
        window.setTimeout(() => term.send('\r'), text ? ENTER_GAP_MS : 0)
        setLine('')
    }, [line, term])

    const onLineChange = (next: string): void => {
        // Ctrl held + one typed character = that control key (Ctrl+R, Ctrl+D …), sent at once
        if (ctrl && next.length === line.length + 1 && next.startsWith(line)) {
            const control = controlCharacter(next.slice(-1))
            if (control) {
                term.send(control)
                setCtrl(false)
                return
            }
        }
        setLine(next)
    }

    const onTouchStart = (event: React.TouchEvent): void => {
        if (wrap) return // the wrapped view scrolls itself
        if (event.touches.length === 2) {
            const [a, b] = [event.touches[0], event.touches[1]]
            pinch.current = { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), scale }
            swipe.current = null
        } else if (event.touches.length === 1) {
            swipe.current = { y: event.touches[0].clientY }
        }
    }
    const onTouchMove = (event: React.TouchEvent): void => {
        if (pinch.current && event.touches.length === 2) {
            const [a, b] = [event.touches[0], event.touches[1]]
            const ratio = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) / pinch.current.distance
            setZoom(Math.max(fitScale, Math.min(MAX_SCALE, pinch.current.scale * ratio)))
        } else if (swipe.current && event.touches.length === 1) {
            // a vertical drag scrolls the Mac's history (sideways is the page's own scroll)
            const dy = event.touches[0].clientY - swipe.current.y
            const lineHeight = 17 * scale
            if (Math.abs(dy) >= lineHeight) {
                term.scrollLines(-Math.trunc(dy / lineHeight))
                swipe.current = { y: event.touches[0].clientY }
            }
        }
    }
    const onTouchEnd = (): void => {
        pinch.current = null
        swipe.current = null
    }

    const statusText =
        term.status === 'connecting' ? 'Connecting…' : term.status === 'exited' ? 'The shell in this session has exited.' : term.status === 'closed' ? 'Reconnecting…' : null

    return (
        <div
            className="phone-terminal"
            data-testid="phone-terminal"
            data-status={term.status}
            data-scale={scale.toFixed(4)}
            data-zoom={zoom === null ? 'fit' : 'zoomed'}
            data-wrap={wrap ? 'on' : 'off'}
        >
            <div className="phone-term-toolbar">
                <span className="phone-term-size" data-testid="phone-terminal-size" title={`The Mac's size, shown at ${Math.round(scale * 100)}%`}>
                    {term.size ? `${term.size.cols}×${term.size.rows}` : '—'}
                </span>
                <button
                    type="button"
                    aria-label="Wrap to screen"
                    aria-pressed={wrap}
                    data-testid="phone-terminal-wrap"
                    title={wrap ? 'Showing the Mac’s screen wrapped to this phone — tap for the screen as it is' : 'Wrap the Mac’s lines to this phone’s width (read at 13px)'}
                    onClick={() => setWrap((on) => !on)}
                >
                    <WrapText size={14} />
                </button>
                {!wrap && (
                    <>
                        <button type="button" aria-label="Zoom out" onClick={() => setZoom(Math.max(fitScale, scale / 1.25))}><Minus size={14} /></button>
                        <button type="button" aria-label="Fit width" data-testid="phone-terminal-fit" onClick={() => setZoom(null)}><Maximize2 size={14} /></button>
                        <button type="button" aria-label="Zoom in" data-testid="phone-terminal-zoom-in" onClick={() => setZoom(Math.min(MAX_SCALE, scale * 1.25))}><Plus size={14} /></button>
                    </>
                )}
                <span className="phone-term-gap" />
                <button type="button" aria-label="Page up" onClick={() => term.scrollPages(-1)}><ChevronsUp size={14} /></button>
                <button type="button" aria-label="Page down" onClick={() => term.scrollPages(1)}><ChevronsDown size={14} /></button>
                <button type="button" aria-label="Scroll to the end" onClick={() => term.scrollToBottom()}><ArrowDownToLine size={14} /></button>
                <div className="phone-seg" role="group" aria-label="View or type">
                    <button type="button" data-testid="phone-terminal-view" aria-pressed={!typing} onClick={() => setTyping(false)}>
                        <Eye size={13} /> View
                    </button>
                    <button
                        type="button"
                        data-testid="phone-terminal-type"
                        aria-pressed={typing}
                        disabled={!canType}
                        title={canType ? 'Show the key bar and input line' : 'This device can only watch'}
                        onClick={() => setTyping(true)}
                    >
                        <Keyboard size={13} /> Type
                    </button>
                </div>
            </div>
            <div
                ref={scroller}
                className="phone-term-scroller"
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                data-testid="phone-terminal-scroller"
                data-wrap={wrap ? '' : undefined}
            >
                <div className="phone-term-sizer" style={natural ? { width: natural.width * scale, height: natural.height * scale } : undefined}>
                    <div ref={host} className="phone-term-host" style={{ transform: `scale(${scale})` }} data-testid="phone-terminal-host" />
                </div>
                {wrap && term.status !== 'connecting' && <PhoneTerminalFold term={term} />}
                {statusText && <div className="phone-term-status">{statusText}</div>}
            </div>
            {term.notice && <div className="phone-toast" role="status" data-testid="phone-terminal-notice">{term.notice}</div>}
            {typing && canType && (
                <div className="phone-term-input" data-testid="phone-key-bar">
                    <div className="phone-key-row">
                        {KEY_BAR_ITEMS.map((item) => (
                            <KeyBarButton key={keyBarLabel(item)} item={item} held={item.type === 'modifier' && ctrl} onKey={sendKey} />
                        ))}
                    </div>
                    <form
                        className="phone-line"
                        onSubmit={(event) => {
                            event.preventDefault()
                            sendLine()
                        }}
                    >
                        <input
                            data-testid="phone-terminal-line"
                            value={line}
                            onChange={(event) => onLineChange(event.target.value)}
                            placeholder={ctrl ? 'Ctrl + a letter…' : 'Type, then send (adds Enter)'}
                            autoCapitalize="off"
                            autoCorrect="off"
                            autoComplete="off"
                            spellCheck={false}
                            enterKeyHint="send"
                        />
                        <button type="submit" aria-label="Send" data-testid="phone-terminal-send"><Send size={15} /></button>
                    </form>
                </div>
            )}
        </div>
    )
}

/**
 * One key of the bar. A tap sends once; holding an arrow repeats it (400 ms, then every 50 ms —
 * ovis keyRepeat.ts) until the finger lifts, and a finger that slides first was scrolling the bar.
 */
function KeyBarButton({ item, held, onKey }: { item: KeyBarItem; held: boolean; onKey: (item: KeyBarItem) => void }) {
    const onKeyRef = useRef(onKey)
    onKeyRef.current = onKey
    const repeat = useMemo(() => (isRepeatable(item) ? createKeyRepeat(() => onKeyRef.current(item)) : null), [item])
    useEffect(() => () => repeat?.cancel(), [repeat])
    return (
        <button
            type="button"
            className="phone-key"
            data-key={item.type === 'key' ? item.key : 'ctrl'}
            aria-pressed={item.type === 'modifier' ? held : undefined}
            onPointerDown={(event) => {
                // keep the keyboard up: a key tap must not take the focus off the input line
                event.preventDefault()
                repeat?.press(event.clientX, event.clientY)
            }}
            onPointerMove={(event) => repeat?.move(event.clientX, event.clientY)}
            onPointerUp={() => repeat?.release()}
            onPointerCancel={() => repeat?.cancel()}
            onPointerLeave={() => repeat?.release()}
            onContextMenu={(event) => event.preventDefault()}
            onClick={() => {
                if (repeat && !repeat.takeClick()) return
                onKey(item)
            }}
        >
            {keyBarLabel(item)}
        </button>
    )
}
