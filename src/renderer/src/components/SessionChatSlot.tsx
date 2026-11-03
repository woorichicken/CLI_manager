import { ChatView } from './ChatView'
import { setSessionViewMode, useSessionViewMode } from '../hooks/useSessionViewMode'
import { electronChatTransport } from '../utils/electronChatTransport'

/**
 * The Chat view over one session's terminal, when that session is switched to
 * Chat. The terminal underneath stays mounted and sized (no PTY resize, no
 * repaint), so going back shows it exactly as it was.
 */
export function SessionChatSlot({
    sessionId,
    visible,
    enabled,
    fontSize
}: {
    sessionId: string
    visible: boolean
    /** the session runs Claude Code or Codex (isAgentSession) */
    enabled: boolean
    fontSize?: number
}) {
    const mode = useSessionViewMode(sessionId)
    if (!visible || !enabled || mode !== 'chat') return null
    return (
        <ChatView
            sessionId={sessionId}
            transport={electronChatTransport}
            fontSize={fontSize}
            onOpenTerminal={() => setSessionViewMode(sessionId, 'terminal')}
        />
    )
}
