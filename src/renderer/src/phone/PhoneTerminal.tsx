import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ArrowDownToLine, ChevronsDown, ChevronsUp, Eye, Keyboard, Maximize2, Minus, Plus, Send } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { PhoneRole } from '../../../shared/phone'
import { KEY_BAR_ITEMS, controlCharacter, keyBarLabel, keySequence, type KeyBarItem } from './keyBar'
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

export function PhoneTerminal({ sessionId, deviceRole }: { sessionId: string; deviceRole: PhoneRole }) {
    const host = useRef<HTMLDivElement>(null)
    const scroller = useRef<HTMLDivElement>(null)
    const term = usePhoneTerminal(sessionId, host)
    const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
    const [fitWidth, setFitWidth] = useState(0)
    const [zoom, setZoom] = useState<number | null>(null) // null: fit the width
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

    const fitScale = natural && fitWidth > 0 ? Math.min(1, fitWidth / natural.width) : 1
    const scale = zoom ?? fitScale

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
        <div className="phone-terminal" data-testid="phone-terminal" data-status={term.status}>
            <div className="phone-term-toolbar">
                <span className="phone-term-size" data-testid="phone-terminal-size">
                    {term.size ? `${term.size.cols}×${term.size.rows}` : '—'} · {Math.round(scale * 100)}%
                </span>
                <button type="button" aria-label="Zoom out" onClick={() => setZoom(Math.max(fitScale, scale / 1.25))}><Minus size={14} /></button>
                <button type="button" aria-label="Fit width" data-testid="phone-terminal-fit" onClick={() => setZoom(null)}><Maximize2 size={14} /></button>
                <button type="button" aria-label="Zoom in" data-testid="phone-terminal-zoom-in" onClick={() => setZoom(Math.min(MAX_SCALE, scale * 1.25))}><Plus size={14} /></button>
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
            >
                <div className="phone-term-sizer" style={natural ? { width: natural.width * scale, height: natural.height * scale } : undefined}>
                    <div ref={host} className="phone-term-host" style={{ transform: `scale(${scale})` }} data-testid="phone-terminal-host" />
                </div>
                {statusText && <div className="phone-term-status">{statusText}</div>}
            </div>
            {term.notice && <div className="phone-toast" role="status" data-testid="phone-terminal-notice">{term.notice}</div>}
            {typing && canType && (
                <div className="phone-term-input" data-testid="phone-key-bar">
                    <div className="phone-key-row">
                        {KEY_BAR_ITEMS.map((item) => {
                            const label = keyBarLabel(item)
                            const held = item.type === 'modifier' && ctrl
                            return (
                                <button
                                    key={label}
                                    type="button"
                                    className="phone-key"
                                    data-key={item.type === 'key' ? item.key : 'ctrl'}
                                    aria-pressed={item.type === 'modifier' ? held : undefined}
                                    // keep the keyboard up: a key tap must not take the focus off the input line
                                    onPointerDown={(event) => event.preventDefault()}
                                    onClick={() => sendKey(item)}
                                >
                                    {label}
                                </button>
                            )
                        })}
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
