import type { AttachResult, ChatCommand, ChatSendResult, DraftFromTerminalResult, DraftToTerminalResult, ChatTransport, ConversationSnapshot, InterruptResult, PromptAnswerResult } from '../../../shared/conversation'
import { MAX_ATTACH_BYTES } from '../../../shared/conversation'
import { chatPath, getJson, postJson, socketUrl } from './api'
import { reconnectDelay } from './usePhoneTerminal'

/**
 * The Chat view's transport on the phone: the same `ChatTransport` the Electron app fills
 * with IPC, filled with fetch and one WebSocket per open chat. The Chat view components are
 * the desktop ones, unchanged. The phone server calls the same ConversationService functions.
 *
 * What a phone cannot do the Mac's way: open a file on the Mac (the chat's file links do
 * nothing here) or search the session's folder for `@` (an empty list).
 */

/** Away from the page this long, the chat socket is not trusted on return. */
const STALE_AFTER_MS = 5_000

export function createPhoneChatTransport(onViewOnly?: (message: string) => void): ChatTransport {
    const refuse = (error: unknown): ChatSendResult => {
        const message = error instanceof Error ? error.message : String(error)
        if (/view_only|only watch/i.test(message)) onViewOnly?.(message)
        return { status: 'rejected', reason: 'not_running', message }
    }
    return {
        getConversation: (sessionId, limit) =>
            getJson<ConversationSnapshot>(`${chatPath(sessionId, 'conversation')}${limit ? `?limit=${limit}` : ''}`),
        subscribe(sessionId, onChange) {
            let socket: WebSocket | null = null
            let stopped = false
            let retry: number | null = null
            let retries = 0
            // a dropped socket (the phone slept, the network moved) comes back as the terminal's does
            const open = (): void => {
                socket = new WebSocket(socketUrl(chatPath(sessionId, 'events')))
                socket.onopen = () => {
                    retries = 0
                }
                socket.onmessage = (event) => {
                    try {
                        const message = JSON.parse(String(event.data)) as { type?: string; revision?: number }
                        if (message.type === 'changed' && typeof message.revision === 'number') onChange(message.revision)
                    } catch {
                        // not ours
                    }
                }
                socket.onclose = () => {
                    if (stopped) return
                    retry = window.setTimeout(reopen, reconnectDelay(retries++))
                }
            }
            const reopen = (): void => {
                retry = null
                // whatever changed while it was gone is fetched once it is back
                onChange(-1)
                open()
            }
            // back on the page or the network: a waiting retry goes now. Back after a while away (the
            // phone slept, another app was in front), the socket may look open and be dead — Android
            // froze the page — and the chat stayed as it was until a reload (24ab5ab1): a fresh one.
            let hiddenAt: number | null = null
            const now = (event?: Event): void => {
                if (document.visibilityState === 'hidden') {
                    hiddenAt ??= Date.now()
                    return
                }
                const away = (hiddenAt !== null && Date.now() - hiddenAt >= STALE_AFTER_MS) || (event as PageTransitionEvent | undefined)?.persisted === true
                hiddenAt = null
                if (stopped) return
                if (retry !== null) {
                    window.clearTimeout(retry)
                    reopen()
                } else if (away) {
                    const old = socket
                    if (old) {
                        old.onclose = null
                        old.onmessage = null
                        old.close()
                    }
                    reopen()
                }
            }
            open()
            document.addEventListener('visibilitychange', now)
            window.addEventListener('online', now)
            window.addEventListener('pageshow', now)
            return () => {
                stopped = true
                document.removeEventListener('visibilitychange', now)
                window.removeEventListener('online', now)
                window.removeEventListener('pageshow', now)
                if (retry !== null) window.clearTimeout(retry)
                socket?.close()
            }
        },
        send: (sessionId, text, options) => postJson<ChatSendResult>(chatPath(sessionId, 'send'), { text, ...(options?.clearDraft !== undefined ? { clearDraft: options.clearDraft } : {}) }).catch(refuse),
        cancelQueued: async (sessionId) => {
            await postJson(chatPath(sessionId, 'cancel-queued'), {}).catch(() => undefined)
        },
        // no catch: a withdrawal that did not get through must not look like one that did (Edit, F19)
        discardQueued: async (sessionId, id) => {
            const result = await postJson<{ discarded?: boolean }>(chatPath(sessionId, 'discard-queued'), { id })
            return result.discarded === true
        },
        sendQueuedNow: (sessionId, id) => postJson<ChatSendResult>(chatPath(sessionId, 'send-queued-now'), { id }).catch(refuse),
        // a failed request moves nothing: the text stays where it was
        placeDraftInTerminal: (sessionId, text) =>
            postJson<DraftToTerminalResult>(chatPath(sessionId, 'draft-to-terminal'), { text }).catch((): DraftToTerminalResult => ({ status: 'refused', reason: 'not_running' })),
        takeTerminalDraft: (sessionId) =>
            postJson<DraftFromTerminalResult>(chatPath(sessionId, 'draft-from-terminal'), {}).catch((): DraftFromTerminalResult => ({ status: 'empty' })),
        interrupt: (sessionId) =>
            postJson<InterruptResult>(chatPath(sessionId, 'interrupt'), {}).catch((error) => ({
                status: 'rejected' as const,
                reason: 'not_running' as const,
                message: error instanceof Error ? error.message : String(error)
            })),
        answerPrompt: (sessionId, answer) =>
            postJson<PromptAnswerResult>(chatPath(sessionId, 'answer'), { answer }).catch((error) => ({
                status: 'rejected' as const,
                reason: 'not_running' as const,
                message: error instanceof Error ? error.message : String(error)
            })),
        async attachFile(sessionId, file): Promise<AttachResult> {
            if (file.size > MAX_ATTACH_BYTES) {
                return { status: 'rejected', reason: 'too_large', message: `Files are limited to ${MAX_ATTACH_BYTES / 1024 / 1024} MB.` }
            }
            try {
                const response = await fetch(`${chatPath(sessionId, 'attach')}?name=${encodeURIComponent(file.name || 'phone-photo')}`, {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: file
                })
                const result = (await response.json()) as AttachResult | { error?: string; message?: string }
                if ('status' in result) return result
                return { status: 'rejected', reason: 'unreadable', message: result.message ?? result.error ?? `HTTP ${response.status}` }
            } catch (error) {
                return { status: 'rejected', reason: 'unreadable', message: error instanceof Error ? error.message : String(error) }
            }
        },
        getImage: async (sessionId, ref) =>
            (await getJson<{ image: string | null }>(`${chatPath(sessionId, 'image')}?ref=${encodeURIComponent(ref)}`).catch(() => ({ image: null }))).image,
        getToolOutput: async (sessionId, ref) =>
            (await getJson<{ output: string | null }>(`${chatPath(sessionId, 'tool-output')}?ref=${encodeURIComponent(ref)}`).catch(() => ({ output: null }))).output,
        listCommands: async (sessionId) =>
            (await getJson<{ commands: ChatCommand[] }>(chatPath(sessionId, 'commands')).catch(() => ({ commands: [] }))).commands,
        searchFiles: async () => [],
        openFile: () => undefined,
        openLink(url) {
            if (/^(https?:|mailto:)/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer')
        }
    }
}
