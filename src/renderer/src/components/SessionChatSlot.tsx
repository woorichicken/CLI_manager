import { MessageSquareText, X } from 'lucide-react'
import type { ChatPreferences } from '../../../shared/conversation'
import { ChatView } from './ChatView'
import { setSessionPeek, setSessionViewMode, useSessionPeek, useSessionViewMode } from '../hooks/useSessionViewMode'
import { electronChatTransport } from '../utils/electronChatTransport'

/**
 * The Chat view over one session's terminal, when that session is switched to
 * Chat. The terminal underneath stays mounted and sized (no PTY resize, no
 * repaint), so going back shows it exactly as it was.
 *
 * After the chat sent a command only the terminal can show (`/config`, a bare
 * `/model`), the session is on its terminal with a small "Back to Chat" bar on
 * top (ovis: Back to Chat · Keep Terminal). The bar floats; the terminal keeps
 * its size.
 */
export function SessionChatSlot({
    sessionId,
    visible,
    enabled,
    fontSize,
    preferences
}: {
    sessionId: string
    visible: boolean
    /** the session runs Claude Code or Codex (isAgentSession) */
    enabled: boolean
    fontSize?: number
    preferences?: ChatPreferences
}) {
    const mode = useSessionViewMode(sessionId)
    const peek = useSessionPeek(sessionId)
    if (!visible || !enabled) return null
    if (mode !== 'chat') {
        if (!peek) return null
        return (
            <div className="chat-peek-bar no-drag" role="status" data-testid="chat-peek-bar">
                <span className="chat-peek-text">
                    Opened for <code>{peek}</code>
                </span>
                <button type="button" data-testid="chat-peek-back" onClick={() => setSessionViewMode(sessionId, 'chat')}>
                    <MessageSquareText size={12} aria-hidden="true" /> Back to Chat
                </button>
                <button type="button" data-testid="chat-peek-keep" title="Keep the terminal" aria-label="Keep Terminal" onClick={() => setSessionPeek(sessionId, null)}>
                    <X size={12} aria-hidden="true" /> Keep Terminal
                </button>
            </div>
        )
    }
    return (
        <ChatView
            sessionId={sessionId}
            transport={electronChatTransport}
            fontSize={fontSize}
            preferences={preferences}
            onOpenTerminal={(command) => {
                setSessionViewMode(sessionId, 'terminal')
                if (command) setSessionPeek(sessionId, command)
                // the keys go where the person now looks
                window.setTimeout(() => {
                    document.querySelector<HTMLTextAreaElement>(`[data-session-id="${CSS.escape(sessionId)}"] .xterm-helper-textarea`)?.focus()
                }, 50)
            }}
        />
    )
}
