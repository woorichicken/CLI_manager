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

const RECONNECT_MS = 2000
const FONT_SIZE = 13
const FONT = 'Menlo, "SF Mono", Monaco, "Courier New", monospace'

export interface PhoneTerminalHandle {
    status: TerminalStatus
    size: { cols: number; rows: number } | null
    /** what the server says this device may do */
    role: PhoneRole | null
    /** the last refusal from the server, shown briefly */
    notice: string | null
    send(data: string): boolean
    applicationCursorKeys(): boolean
    scrollPages(pages: number): void
    scrollToBottom(): void
    scrollLines(lines: number): void
}

export function usePhoneTerminal(sessionId: string, host: React.RefObject<HTMLDivElement | null>): PhoneTerminalHandle {
    const termRef = useRef<Terminal | null>(null)
    const socketRef = useRef<WebSocket | null>(null)
    const [status, setStatus] = useState<TerminalStatus>('connecting')
    const [size, setSize] = useState<{ cols: number; rows: number } | null>(null)
    const [role, setRole] = useState<PhoneRole | null>(null)
    const [notice, setNotice] = useState<string | null>(null)

    useEffect(() => {
        const element = host.current
        if (!element) return
        const term = new Terminal({
            theme: { background: '#0f0f12', foreground: '#e0e0e0', cursor: '#ffffff', selectionBackground: 'rgba(255, 255, 255, 0.3)' },
            fontFamily: FONT,
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

        let stopped = false
        let retry: number | null = null
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
                retry = window.setTimeout(() => {
                    if (!stopped) open()
                }, RECONNECT_MS)
            }
        }
        open()

        return () => {
            stopped = true
            if (retry !== null) window.clearTimeout(retry)
            if (noticeTimer !== null) window.clearTimeout(noticeTimer)
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

    return {
        status,
        size,
        role,
        notice,
        send,
        applicationCursorKeys: () => termRef.current?.modes.applicationCursorKeysMode ?? false,
        scrollPages: (pages) => termRef.current?.scrollPages(pages),
        scrollToBottom: () => termRef.current?.scrollToBottom(),
        scrollLines: (lines) => termRef.current?.scrollLines(lines)
    }
}
