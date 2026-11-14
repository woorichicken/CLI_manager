import type { AttachResult, ChatTransport, ConversationSnapshot } from '../../../shared/conversation'
import { MAX_ATTACH_BYTES } from '../../../shared/conversation'

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
    meta: null,
    revision: 0
})

/** The folder each session's last snapshot named, for the file search (`searchFiles`). */
const cwdBySession = new Map<string, string>()

/**
 * How the app shows a file the chat names: App registers its preview (`FilePreview` for
 * pictures and text, the Mac's own app for the rest). Unset (a window without a preview),
 * the file opens in the Mac's own app.
 */
type FileOpener = (path: string, line?: number, sessionId?: string) => void
let fileOpener: FileOpener | null = null
export function setChatFileOpener(opener: FileOpener | null): void {
    fileOpener = opener
}

const SEARCH_RESULTS = 30

export const electronChatTransport: ChatTransport = {
    async getConversation(sessionId, limit) {
        const snapshot = (await window.api.getConversation(sessionId, limit)) ?? empty(sessionId)
        if (snapshot.cwd) cwdBySession.set(sessionId, snapshot.cwd)
        return snapshot
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
    send: (sessionId, text, options) => window.api.sendChatMessage(sessionId, text, options),
    cancelQueued: (sessionId) => window.api.cancelQueuedChat(sessionId),
    discardQueued: (sessionId, id) => window.api.discardQueuedChat(sessionId, id),
    sendQueuedNow: (sessionId, id) => window.api.sendQueuedChatNow(sessionId, id),
    placeDraftInTerminal: (sessionId, text) => window.api.placeChatDraftInTerminal(sessionId, text),
    takeTerminalDraft: (sessionId) => window.api.takeTerminalDraft(sessionId),
    interrupt: (sessionId) => window.api.interruptChat(sessionId),
    fork: (sessionId, request) => window.api.forkChat(sessionId, request),
    getThreads: (sessionId) => window.api.getChatThreads(sessionId),
    subscribeThreads(sessionId, onChange) {
        const off = window.api.onChatThreadsChanged((change) => {
            if (change.sessionId === sessionId) onChange()
        })
        void window.api.subscribeChatThreads(sessionId)
        return () => {
            off()
            void window.api.unsubscribeChatThreads(sessionId)
        }
    },
    answerPrompt: (sessionId, answer) => window.api.answerPrompt(sessionId, answer),
    async attachFile(_sessionId, file): Promise<AttachResult> {
        // A picked or dropped file is already on this Mac: the agent reads it where it is.
        let own = ''
        try {
            own = window.api.getFilePath(file)
        } catch {
            own = ''
        }
        if (own) return { status: 'attached', path: own }
        if (file.size > MAX_ATTACH_BYTES) {
            return { status: 'rejected', reason: 'too_large', message: `Files are limited to ${MAX_ATTACH_BYTES / 1024 / 1024} MB.` }
        }
        try {
            const bytes = new Uint8Array(await file.arrayBuffer())
            return await window.api.saveChatAttachment(file.name || 'pasted', bytes)
        } catch (error) {
            return { status: 'rejected', reason: 'unreadable', message: error instanceof Error ? error.message : String(error) }
        }
    },
    getImage: (sessionId, ref) => window.api.getChatImage(sessionId, ref),
    getToolOutput: (sessionId, ref) => window.api.getChatToolOutput(sessionId, ref),
    listCommands: (sessionId) => window.api.listChatCommands(sessionId),
    listBackgroundTasks: (sessionId) => window.api.listChatBackgroundTasks(sessionId),
    async searchFiles(sessionId, query) {
        const cwd = cwdBySession.get(sessionId)
        if (!cwd) return []
        const result = await window.api.searchFiles(cwd, query)
        return result.success ? result.files.slice(0, SEARCH_RESULTS).map((file) => file.relativePath) : []
    },
    openFile(sessionId, path, line) {
        if (fileOpener) fileOpener(path, line, sessionId)
        else void window.api.openChatPath(path, sessionId)
    },
    openLink(url) {
        if (/^(https?:|mailto:)/i.test(url)) void window.api.openExternal(url)
    },
    dictation: {
        status: () => window.api.dictationStatus(),
        start: (context) => window.api.startDictation(context),
        stop: (id) => window.api.stopDictation(id),
        cancel: (id, reason) => window.api.cancelDictation(id, reason),
        report: (id, outcome) => window.api.reportDictation(id, outcome),
        onEvent: (listener) => window.api.onDictationEvent(listener)
    }
}
