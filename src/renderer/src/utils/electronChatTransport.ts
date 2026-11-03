import type { ChatTransport, ConversationSnapshot } from '../../../shared/conversation'

/**
 * The Chat view's transport inside the Electron app: main's ConversationService
 * over IPC. The only file that connects the Chat view to `window.api` — the
 * components take a `ChatTransport` so a phone page can hand them its own.
 */

const empty = (sessionId: string): ConversationSnapshot => ({
    sessionId,
    agent: null,
    unavailable: 'no-conversation',
    turns: [],
    totalTurns: 0,
    truncated: false,
    working: false,
    prompt: null,
    queued: [],
    revision: 0
})

export const electronChatTransport: ChatTransport = {
    async getConversation(sessionId, limit) {
        return (await window.api.getConversation(sessionId, limit)) ?? empty(sessionId)
    },
    subscribe(sessionId, onChange) {
        void window.api.subscribeConversation(sessionId)
        const off = window.api.onConversationChanged((change) => {
            if (change.sessionId === sessionId) onChange(change.revision)
        })
        return () => {
            off()
            void window.api.unsubscribeConversation(sessionId)
        }
    },
    send: (sessionId, text) => window.api.sendChatMessage(sessionId, text),
    cancelQueued: (sessionId) => window.api.cancelQueuedChat(sessionId),
    answerPrompt: (sessionId, answer) => window.api.answerPrompt(sessionId, answer)
}
