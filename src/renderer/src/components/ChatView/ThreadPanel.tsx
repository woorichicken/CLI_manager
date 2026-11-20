import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { ExternalLink, MessagesSquare, X } from 'lucide-react'
import type { ChatThread } from '../../../../shared/conversation'

const STATUS_WORDS: Record<ChatThread['status'], string> = { working: 'Working', waiting: 'Waiting for you', idle: 'Idle' }

/** The panel's width the person dragged to (fb-1117 9a135707); absent: the default clamp in chat.css. */
export const THREAD_PANEL_WIDTH_KEY = 'chat-thread-panel-width'
export const THREAD_PANEL_MIN_WIDTH = 300
export const THREAD_PANEL_MAX_WIDTH = 960
/** What the chat beside it keeps at least; chat.css clamps the saved width to this too, when the window narrows. */
export const THREAD_PANEL_MAIN_MIN_WIDTH = 360
const KEY_STEP = 24

function savedWidth(): number | null {
    try {
        const value = Number(window.localStorage.getItem(THREAD_PANEL_WIDTH_KEY))
        return Number.isFinite(value) && value >= THREAD_PANEL_MIN_WIDTH ? Math.min(value, THREAD_PANEL_MAX_WIDTH) : null
    } catch {
        return null
    }
}

function saveWidth(width: number | null): void {
    try {
        if (width === null) window.localStorage.removeItem(THREAD_PANEL_WIDTH_KEY)
        else window.localStorage.setItem(THREAD_PANEL_WIDTH_KEY, String(Math.round(width)))
    } catch {
        // a blocked storage only loses the width for the next panel
    }
}

/** The widest the panel may be in a chat view this wide. */
function widestFor(viewWidth: number): number {
    return Math.max(THREAD_PANEL_MIN_WIDTH, Math.min(THREAD_PANEL_MAX_WIDTH, viewWidth - THREAD_PANEL_MAIN_MIN_WIDTH))
}

/**
 * The thread's name; a click edits it in place (b808043e) — Enter or leaving the field saves, Escape keeps
 * the old one. Until the thread list catches up the saved name stays on screen.
 */
function ThreadName({ name, onRename }: { name: string; onRename?: (name: string) => Promise<boolean> }) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(name)
    const [saved, setSaved] = useState<string | null>(null)
    const field = useRef<HTMLInputElement>(null)
    useEffect(() => setSaved(null), [name])
    useLayoutEffect(() => {
        if (editing) field.current?.select()
    }, [editing])
    const shown = saved ?? name
    if (!onRename) return <span className="chat-thread-panel-name" title={shown}>{shown}</span>
    if (!editing) {
        return (
            <button type="button" className="chat-thread-panel-name" data-testid="chat-thread-rename" title={`${shown} — click to rename`}
                onClick={() => { setDraft(shown); setEditing(true) }}>
                {shown}
            </button>
        )
    }
    const finish = (save: boolean): void => {
        setEditing(false)
        const next = draft.trim()
        if (!save || !next || next === shown) return
        setSaved(next)
        void onRename(next).then((ok) => { if (!ok) setSaved(null) }, () => setSaved(null))
    }
    return (
        <input ref={field} className="chat-thread-panel-name-input" data-testid="chat-thread-rename-input" aria-label="Thread name" value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => finish(true)}
            onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return
                if (event.key === 'Enter') { event.preventDefault(); finish(true) }
                if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(false) }
            }} />
    )
}

/** A shell around a child ChatView: keeping it as children avoids a recursive view import. */
export function ThreadPanel({ thread, agentName, quote, onClose, onOpenSession, onRename, children }: {
    thread: ChatThread
    agentName: string
    quote: string
    onClose: () => void
    onOpenSession?: () => void
    onRename?: (name: string) => Promise<boolean>
    children: ReactNode
}) {
    const panel = useRef<HTMLElement>(null)
    const [width, setWidth] = useState<number | null>(savedWidth)
    const [dragging, setDragging] = useState(false)
    useLayoutEffect(() => {
        panel.current?.focus({ preventScroll: true })
    }, [thread.childId])
    const limits = (): { min: number; max: number } => {
        const view = panel.current?.parentElement?.getBoundingClientRect().width ?? 0
        return { min: THREAD_PANEL_MIN_WIDTH, max: widestFor(view) }
    }
    const resize = (next: number): number => {
        const { min, max } = limits()
        const clamped = Math.round(Math.max(min, Math.min(max, next)))
        setWidth(clamped)
        return clamped
    }
    const currentWidth = (): number => width ?? panel.current?.getBoundingClientRect().width ?? THREAD_PANEL_MIN_WIDTH
    // drag the panel's left edge: the panel's right edge stays where it is
    const startDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
        if (event.button !== 0 || !panel.current) return
        event.preventDefault()
        const right = panel.current.getBoundingClientRect().right
        const handle = event.currentTarget
        handle.setPointerCapture(event.pointerId)
        setDragging(true)
        let last = currentWidth()
        const move = (moved: PointerEvent): void => { last = resize(right - moved.clientX) }
        const end = (): void => {
            handle.removeEventListener('pointermove', move)
            handle.removeEventListener('pointerup', end)
            handle.removeEventListener('pointercancel', end)
            setDragging(false)
            saveWidth(last)
        }
        handle.addEventListener('pointermove', move)
        handle.addEventListener('pointerup', end)
        handle.addEventListener('pointercancel', end)
    }
    const resetWidth = (): void => {
        setWidth(null)
        saveWidth(null)
    }
    const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
        const step = event.key === 'ArrowLeft' ? KEY_STEP : event.key === 'ArrowRight' ? -KEY_STEP : 0
        if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            event.stopPropagation()
            saveWidth(resize(event.key === 'Home' ? limits().max : limits().min))
            return
        }
        if (!step) return
        event.preventDefault()
        event.stopPropagation()
        saveWidth(resize(currentWidth() + step))
    }
    const style = width === null ? undefined : ({ '--chat-thread-panel-width': `${width}px` } as CSSProperties)
    return (
        <aside
            ref={panel}
            className="chat-thread-panel"
            data-testid="chat-thread-panel"
            data-session-id={thread.childId}
            data-resized={width === null ? undefined : 'true'}
            data-dragging={dragging ? 'true' : undefined}
            style={style}
            aria-label={`Thread: ${thread.name}`}
            tabIndex={-1}
            onKeyDown={(event) => {
                if (event.key !== 'Escape' || event.defaultPrevented) return
                event.preventDefault()
                event.stopPropagation()
                onClose()
            }}
        >
            <div
                className="chat-thread-panel-resize"
                data-testid="chat-thread-panel-resize"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize thread panel"
                aria-valuemin={THREAD_PANEL_MIN_WIDTH}
                aria-valuemax={THREAD_PANEL_MAX_WIDTH}
                aria-valuenow={width ?? undefined}
                tabIndex={0}
                title="Drag to resize · double-click to reset"
                onPointerDown={startDrag}
                onDoubleClick={resetWidth}
                onKeyDown={resizeByKey}
            />
            <header className="chat-thread-panel-header">
                <div className="chat-thread-panel-title">
                    <MessagesSquare size={15} aria-hidden="true" />
                    <ThreadName name={thread.name} onRename={onRename} />
                </div>
                <div className="chat-thread-panel-actions">
                    {onOpenSession && <button type="button" className="chat-thread-open-session" data-testid="chat-thread-open-session" onClick={onOpenSession} title="Open as session">
                        <ExternalLink size={12} aria-hidden="true" /> Open as session
                    </button>}
                    <button type="button" className="chat-thread-panel-close" data-testid="chat-thread-panel-close" title="Close thread" aria-label="Close thread" onClick={onClose}>
                        <X size={16} aria-hidden="true" />
                    </button>
                </div>
                <div className="chat-thread-panel-status">
                    <span className="chat-thread-status-dot" data-testid="chat-thread-status-dot" data-status={thread.status} aria-hidden="true" />
                    <span>{STATUS_WORDS[thread.status]}</span>
                </div>
            </header>
            {/* the reply it hangs on, as a message like the chat's own (c04532a6) */}
            <div className="chat-thread-quote" data-testid="chat-thread-quote">
                {quote && <blockquote className="chat-thread-quote-text">{quote}</blockquote>}
                <div className="chat-thread-quote-label">Replying to {agentName}</div>
            </div>
            <div className="chat-thread-body">{children}</div>
        </aside>
    )
}
