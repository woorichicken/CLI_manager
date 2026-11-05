import type { WebSocket } from 'ws'
import type { PhoneRole, PhoneTerminalServerMessage } from '../../shared/phone'
import { PHONE_MAX_INPUT_LENGTH } from '../../shared/phone'
import type { TerminalEventBus } from '../TerminalManager'

/**
 * The phone's two sockets.
 *
 * Terminal: the mirror's snapshot first, then live output, in order (invariant 6). The
 * phone draws at the Mac's size and is told when the Mac's window changes it. Input
 * from a `drive` connection goes to the pty like typed keys and lands in the session's
 * event log as from the phone. There is no resize message: one that arrives is answered
 * with an error and changes nothing — a phone must never repaint the Mac's agent at 40
 * columns (invariant 2; the width change is the cut-off case not fixed yet).
 *
 * Chat events: the revision each time the conversation, the working state or the
 * question changes, so the page fetches only then.
 */

/** A phone that cannot keep up (a tunnel gone quiet) is dropped instead of buffered forever. */
const MAX_BUFFERED_BYTES = 8 * 1024 * 1024
/** Proxies and phones drop sockets that say nothing; a ping keeps them. */
const PING_MS = 25_000

export interface PhoneSocketDeps {
    terminals: {
        attachRemote(id: string, sink: (data: string) => void): Promise<{ snapshot: string | null; cols: number; rows: number; detach: () => void } | null>
        writeInput(id: string, data: string): boolean
        events: TerminalEventBus
    }
    recordPhoneInput(sessionId: string, detail: string): void
    /** ConversationService subscription for one socket; returns the unsubscribe */
    subscribeConversation(sessionId: string, onChange: (revision: number) => void): () => void
    sessionExists(id: string): boolean
    /** tests: count of resize messages refused, read from main */
    onResizeRefused?(sessionId: string): void
}

function keepAlive(ws: WebSocket): () => void {
    let alive = true
    ws.on('pong', () => {
        alive = true
    })
    const timer = setInterval(() => {
        if (!alive) {
            ws.terminate()
            return
        }
        alive = false
        ws.ping()
    }, PING_MS)
    return () => clearInterval(timer)
}

/**
 * `stillAllowed`: the access this socket was opened with, asked again before each input — a revoked
 * device's socket is only closing (ws keeps emitting its frames until the phone answers the close).
 */
export function handleTerminalSocket(ws: WebSocket, sessionId: string, role: PhoneRole, deps: PhoneSocketDeps, stillAllowed: () => boolean): void {
    let ready = false
    let closed = false
    const queued: string[] = []
    let detach: (() => void) | null = null
    const stopPing = keepAlive(ws)

    const sendMessage = (message: PhoneTerminalServerMessage): void => {
        if (closed || ws.readyState !== ws.OPEN) return
        if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
            ws.close(4408, 'too slow')
            return
        }
        ws.send(JSON.stringify(message))
    }
    const sink = (data: string): void => {
        if (ready) sendMessage({ type: 'output', data })
        else queued.push(data)
    }
    const onResized = (id: string, cols: number, rows: number): void => {
        if (id === sessionId) sendMessage({ type: 'size', cols, rows })
    }
    const onExited = (id: string): void => {
        if (id !== sessionId) return
        sendMessage({ type: 'exit' })
        ws.close(1000, 'exited')
    }
    deps.terminals.events.on('resized', onResized)
    deps.terminals.events.on('exited', onExited)

    const cleanup = (): void => {
        if (closed) return
        closed = true
        stopPing()
        detach?.()
        deps.terminals.events.off('resized', onResized)
        deps.terminals.events.off('exited', onExited)
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)

    ws.on('message', (raw) => {
        // closing (revoked, Phone off, exited) or no longer allowed: nothing more reaches the pty
        if (closed || ws.readyState !== ws.OPEN || !stillAllowed()) return
        let message: { type?: unknown; data?: unknown } | null = null
        try {
            message = JSON.parse(String(raw))
        } catch {
            message = null
        }
        if (!message || typeof message !== 'object') {
            sendMessage({ type: 'error', reason: 'bad_message', message: 'Not a message.' })
            return
        }
        if (message.type !== 'input') {
            const sizeLike = message.type === 'resize' || 'cols' in message || 'rows' in message
            if (sizeLike) deps.onResizeRefused?.(sessionId)
            sendMessage(
                sizeLike
                    ? { type: 'error', reason: 'resize_not_allowed', message: 'The phone shows the Mac terminal at its own size.' }
                    : { type: 'error', reason: 'bad_message', message: 'Unknown message.' }
            )
            return
        }
        if (role !== 'drive') {
            sendMessage({ type: 'error', reason: 'view_only', message: 'This device can only watch.' })
            return
        }
        if (typeof message.data !== 'string' || message.data.length === 0) return
        if (message.data.length > PHONE_MAX_INPUT_LENGTH) {
            sendMessage({ type: 'error', reason: 'too_large', message: `Input is limited to ${PHONE_MAX_INPUT_LENGTH} characters at a time.` })
            return
        }
        if (deps.terminals.writeInput(sessionId, message.data)) deps.recordPhoneInput(sessionId, 'typed in the terminal')
    })

    void deps.terminals.attachRemote(sessionId, sink).then((attached) => {
        if (closed) {
            attached?.detach()
            return
        }
        if (!attached) {
            sendMessage({ type: 'exit' })
            ws.close(1000, 'not running')
            cleanup()
            return
        }
        detach = attached.detach
        sendMessage({ type: 'snapshot', data: attached.snapshot ?? '', cols: attached.cols, rows: attached.rows, role })
        for (const data of queued.splice(0)) sendMessage({ type: 'output', data })
        ready = true
    })
}

export function handleChatSocket(ws: WebSocket, sessionId: string, deps: PhoneSocketDeps): void {
    const stopPing = keepAlive(ws)
    const off = deps.subscribeConversation(sessionId, (revision) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'changed', revision }))
    })
    let done = false
    const cleanup = (): void => {
        if (done) return
        done = true
        stopPing()
        off()
    }
    ws.on('close', cleanup)
    ws.on('error', cleanup)
    // the page sends nothing here
    ws.on('message', () => undefined)
}
