import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { SendHorizontal } from 'lucide-react'
import type { ChatSendResult, ChatTransport } from '../../../../shared/conversation'

/**
 * A draft per session, kept while the app runs and across restarts
 * (localStorage `chat-drafts`) — switching sessions or views never loses one.
 */
const DRAFTS_KEY = 'chat-drafts'
const drafts: Record<string, string> = (() => {
    try {
        const parsed = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
    } catch {
        return {}
    }
})()

function saveDraft(sessionId: string, text: string): void {
    if (text) drafts[sessionId] = text
    else delete drafts[sessionId]
    try {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
    } catch {
        // storage blocked: the draft still lives in memory
    }
}

/** After the terminal's own focus-on-show (TerminalView) has run. */
const FOCUS_DELAY_MS = 150

/** Taller than this, the box scrolls instead of growing. */
const MAX_ROWS = 10

/**
 * Several lines, Enter sends, Shift+Enter breaks the line. Sending types into
 * the session's own terminal through main (the Control API's typing path). Main
 * refuses while a question is on screen or the terminal's input line already
 * holds text, and queues it while the agent works — the note under the box says
 * which happened.
 */
export function Composer({
    sessionId,
    transport,
    disabled,
    disabledReason,
    agentName,
    onSent
}: {
    sessionId: string
    transport: ChatTransport
    disabled: boolean
    disabledReason?: string
    agentName: string
    onSent: () => void
}) {
    const [text, setText] = useState(() => drafts[sessionId] ?? '')
    const [sending, setSending] = useState(false)
    const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
    const box = useRef<HTMLTextAreaElement>(null)

    useEffect(() => {
        setText(drafts[sessionId] ?? '')
        setNotice(null)
        // The terminal under the chat may still hold focus: keys would go to it unseen.
        // Take focus only from it (or from nothing), never from another input.
        const timer = window.setTimeout(() => {
            const active = document.activeElement
            const terminal = active?.closest?.(`[data-session-id="${CSS.escape(sessionId)}"]`)
            if (!active || active === document.body || (terminal && active.closest('.xterm'))) box.current?.focus()
        }, FOCUS_DELAY_MS)
        return () => window.clearTimeout(timer)
    }, [sessionId])

    useEffect(() => {
        const element = box.current
        if (!element) return
        element.style.height = 'auto'
        const line = parseFloat(getComputedStyle(element).lineHeight) || 18
        element.style.height = `${Math.min(element.scrollHeight, line * MAX_ROWS + 16)}px`
    }, [text])

    const send = async (): Promise<void> => {
        if (!text.trim() || sending || disabled) return
        setSending(true)
        setNotice(null)
        let result: ChatSendResult
        try {
            result = await transport.send(sessionId, text)
        } catch (error) {
            result = { status: 'rejected', reason: 'not_running', message: error instanceof Error ? error.message : String(error) }
        }
        setSending(false)
        if (result.status === 'rejected') {
            setNotice({ tone: 'error', text: result.message })
            return
        }
        setText('')
        saveDraft(sessionId, '')
        if (result.status === 'queued') setNotice({ tone: 'info', text: `${agentName} is working — it gets this when the turn ends.` })
        onSent()
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        // IME composition (Korean, Japanese): Enter confirms the character, it does not send.
        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault()
            void send()
        }
    }

    return (
        <div className="chat-composer">
            <div className="chat-composer-row">
                <textarea
                    ref={box}
                    rows={1}
                    value={text}
                    data-testid="chat-composer"
                    placeholder={disabled ? disabledReason : `Message ${agentName} (Enter to send)`}
                    title="Enter sends · Shift+Enter starts a new line"
                    disabled={disabled}
                    onChange={(event) => {
                        setText(event.target.value)
                        saveDraft(sessionId, event.target.value)
                    }}
                    onKeyDown={onKeyDown}
                />
                <button
                    type="button"
                    className="chat-composer-send"
                    data-testid="chat-send"
                    disabled={disabled || sending || !text.trim()}
                    onClick={() => void send()}
                    title="Send (Enter)"
                    aria-label="Send"
                >
                    <SendHorizontal size={15} />
                </button>
            </div>
            {notice && (
                <p className={`chat-composer-note${notice.tone === 'error' ? ' is-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="chat-composer-note">
                    {notice.text}
                </p>
            )}
        </div>
    )
}
