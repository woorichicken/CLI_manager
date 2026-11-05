import { getSessionViewMode, setSessionViewMode, type SessionViewMode } from '../hooks/useSessionViewMode'
import { carryDraft } from '../components/ChatView/draftHandoff'
import { electronChatTransport } from './electronChatTransport'

/**
 * Terminal ↔ Chat from the header button or ⌘⇧M: switches, and carries what was being written
 * (4b9cb0c2 — draftHandoff.ts). The peek's own «Back to Chat» and «Keep Terminal» only switch.
 */
export function switchSessionView(sessionId: string, next: SessionViewMode): void {
    const from = getSessionViewMode(sessionId)
    setSessionViewMode(sessionId, next)
    carryDraft(electronChatTransport, sessionId, from, next)
}
