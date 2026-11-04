import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import type { PhoneRole, PhoneTerminalClientMessage, PhoneTerminalServerMessage } from '../../../shared/phone'
import { PHONE_API } from '../../../shared/phone'
import { socketUrl } from './api'

/**
 * One phone view of a Mac terminal: xterm.js drawn at the Mac pty's size, fed by the
 * phone server's socket — the mirror's snapshot first, then live output (invariant 6).
 * It has no way to resize the pty: the only message it sends is input.
 */

export type TerminalStatus = 'connecting' | 'live' | 'exited' | 'closed'

/**
 * Reconnecting (ovis src/lib/ws.ts:37-38, 175-179): the wait doubles from 250 ms up to 5 s and
 * starts over only after a connection that stayed 10 s; coming back to the page or to the
 * network tries at once — iOS drops a backgrounded page's sockets, so the usual reason for a
 * closed socket is a phone taken out of a pocket, and 2 s of a dead screen then is the wait.
 */
export function reconnectDelay(retries: number): number {
    return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** retries)
}
/** the phone terminal's colours — the wrapped view draws with the same */
export const TERMINAL_THEME = { background: '#0f0f12', foreground: '#e0e0e0', cursor: '#ffffff' }
const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5000
const STABLE_MS = 10_000
export const FONT_SIZE = 13
/** before the bundled font has loaded, and for what it does not hold (box drawing, symbols) */
const FALLBACK_FONT = 'Menlo, "SF Mono", Monaco, "Courier New", monospace'
/** the phone page's own font first (phone.css, G3): Hangul exactly two Latin cells wide */
export const FONT = `"CLIM Phone Mono", ${FALLBACK_FONT}`
const FONT_FACE = `${FONT_SIZE}px "CLIM Phone Mono"`

/**
 * xterm measures a cell once per font: a terminal opened before the font arrived would keep the
 * fallback's cell. So it opens with the fallback and switches when the font is in (a new family
 * string makes xterm measure again).
 */
function bundledFontLoaded(): boolean {
    try {
        return document.fonts.check(FONT_FACE)
    } catch {
        return false
    }
}

export interface PhoneTerminalHandle {
    status: TerminalStatus
    size: { cols: number; rows: number } | null
    /** what the server says this device may do */
    role: PhoneRole | null
    /** the last refusal from the server, shown briefly */
    notice: string | null
    /** bumps when the cell size changed without a new grid size (the bundled font arrived) */
    fontVersion: number
    send(data: string): boolean
    /**
     * Types a line, then its Enter after `gapMs` — both on the same connection: when the socket
     * closed in between, the Enter is dropped rather than sent alone on the next one. False when
     * the text could not go (not connected), so the caller keeps it.
     */
    sendLine(text: string, gapMs: number): boolean
    applicationCursorKeys(): boolean
    scrollPages(pages: number): void
    scrollToBottom(): void
    scrollLines(lines: number): void
    /** the xterm under the view — the wrapped view (terminalFold.ts) reads its buffer */
    terminal(): Terminal | null
    /** called (once a frame at most) when what the grid shows changed: output, a scroll, a new size */
    subscribe(listener: () => void): () => void
}

export function usePhoneTerminal(sessionId: string, host: React.RefObject<HTMLDivElement | null>): PhoneTerminalHandle {
    const termRef = useRef<Terminal | null>(null)
    const listeners = useRef(new Set<() => void>())
    const socketRef = useRef<WebSocket | null>(null)
    const [status, setStatus] = useState<TerminalStatus>('connecting')
    const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
    const [role, setRole] = useState<PhoneRole | null>(null)
    const [notice, setNotice] = useState<string | null>(null)
    const [fontVersion, setFontVersion] = useState(0)

    useEffect(() => {
        const element = host.current
        if (!element) return
        const term = new Terminal({
            theme: { ...TERMINAL_THEME, selectionBackground: 'rgba(255, 255, 255, 0.3)' },
            fontFamily: bundledFontLoaded() ? FONT : FALLBACK_FONT,
            fontSize: FONT_SIZE,
            scrollback: 5000,
            // same rule as the desktop view: a CLI's full clear goes to scrollback, not away
            scrollOnEraseInDisplay: true,
            // the phone types through the key bar and the input line, never xterm's own textarea
            disableStdin: true,
            cursorBlink: false,
            allowProposedApi: true
        })
        term.open(element)
        termRef.current = term
        if (term.options.fontFamily !== FONT) {
            document.fonts
                ?.load(FONT_FACE)
                .then(() => {
                    if (termRef.current !== term) return
                    term.options.fontFamily = FONT
                    setFontVersion((version) => version + 1)
                })
                .catch(() => undefined) // not loaded: the fallback stays
        }
        let frame = 0
        const changed = (): void => {
            if (frame || listeners.current.size === 0) return
            frame = window.requestAnimationFrame(() => {
                frame = 0
                for (const listener of listeners.current) listener()
            })
        }
        const watchers = [term.onWriteParsed(changed), term.onScroll(changed), term.onResize(changed)]

        let stopped = false
        let retry: number | null = null
        let retries = 0
        let liveSince = 0
        let noticeTimer: number | null = null
        const open = (): void => {
            setStatus('connecting')
            const socket = new WebSocket(socketUrl(`${PHONE_API.terminal}?session=${encodeURIComponent(sessionId)}`))
            socketRef.current = socket
            socket.onmessage = (event) => {
                let message: PhoneTerminalServerMessage
                try {
                    message = JSON.parse(String(event.data)) as PhoneTerminalServerMessage
                } catch {
                    return
                }
                switch (message.type) {
                    case 'snapshot':
                        term.reset()
                        term.resize(message.cols, message.rows)
                        term.write(message.data)
                        setSize({ cols: message.cols, rows: message.rows })
                        setRole(message.role)
                        setStatus('live')
                        liveSince = Date.now()
                        break
                    case 'output':
                        term.write(message.data)
                        break
                    case 'size':
                        term.resize(message.cols, message.rows)
                        setSize({ cols: message.cols, rows: message.rows })
                        break
                    case 'exit':
                        setStatus('exited')
                        break
                    case 'error':
                        setNotice(message.message)
                        if (noticeTimer !== null) window.clearTimeout(noticeTimer)
                        noticeTimer = window.setTimeout(() => setNotice(null), 4000)
                        break
                }
            }
            socket.onclose = () => {
                if (socketRef.current === socket) socketRef.current = null
                if (stopped) return
                setStatus((current) => (current === 'exited' ? current : 'closed'))
                if (liveSince && Date.now() - liveSince >= STABLE_MS) retries = 0
                liveSince = 0
                retry = window.setTimeout(() => {
                    retry = null
                    if (!stopped) open()
                }, reconnectDelay(retries++))
            }
        }
        open()
        // back on the page or the network: a waiting retry goes now
        const now = (): void => {
            if (stopped || retry === null || document.visibilityState !== 'visible') return
            window.clearTimeout(retry)
            retry = null
            open()
        }
        document.addEventListener('visibilitychange', now)
        window.addEventListener('online', now)
        window.addEventListener('pageshow', now)

        return () => {
            stopped = true
            document.removeEventListener('visibilitychange', now)
            window.removeEventListener('online', now)
            window.removeEventListener('pageshow', now)
            if (retry !== null) window.clearTimeout(retry)
            if (noticeTimer !== null) window.clearTimeout(noticeTimer)
            if (frame) window.cancelAnimationFrame(frame)
            for (const watcher of watchers) watcher.dispose()
            socketRef.current?.close()
            socketRef.current = null
            term.dispose()
            termRef.current = null
        }
    }, [sessionId, host])

    const send = useCallback((data: string): boolean => {
        const socket = socketRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN || !data) return false
        const message: PhoneTerminalClientMessage = { type: 'input', data }
        socket.send(JSON.stringify(message))
        return true
    }, [])

    const sendLine = useCallback((text: string, gapMs: number): boolean => {
        const socket = socketRef.current
        if (!socket || socket.readyState !== WebSocket.OPEN) return false
        const input = (data: string): void => {
            const message: PhoneTerminalClientMessage = { type: 'input', data }
            socket.send(JSON.stringify(message))
        }
        if (!text) {
            input('\r')
            return true
        }
        input(text)
        // the program sees the text land before its Enter, as typed
        window.setTimeout(() => {
            if (socketRef.current === socket && socket.readyState === WebSocket.OPEN) input('\r')
        }, gapMs)
        return true
    }, [])

    const subscribe = useCallback((listener: () => void) => {
        listeners.current.add(listener)
        return () => {
            listeners.current.delete(listener)
        }
    }, [])

    return {
        status,
        size,
        role,
        notice,
        fontVersion,
        send,
        sendLine,
        applicationCursorKeys: () => termRef.current?.modes.applicationCursorKeysMode ?? false,
        scrollPages: (pages) => termRef.current?.scrollPages(pages),
        scrollToBottom: () => termRef.current?.scrollToBottom(),
        scrollLines: (lines) => termRef.current?.scrollLines(lines),
        terminal: () => termRef.current,
        subscribe
    }
}
