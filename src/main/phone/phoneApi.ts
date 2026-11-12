import type http from 'http'
import type {
    AttachResult,
    BackgroundTaskList,
    ChatCommand,
    ChatForkRequest,
    ChatForkResult,
    ChatSendOptions,
    ChatSendResult,
    DraftFromTerminalResult,
    DraftToTerminalResult,
    ConversationSnapshot,
    InterruptResult,
    PromptAnswer,
    PromptAnswerResult,
    PromptMenu
} from '../../shared/conversation'
import { MAX_ATTACH_BYTES } from '../../shared/conversation'
import type { PhoneSessionsResponse } from '../../shared/phone'
import { PHONE_API, type PhoneMemoResponse, type PhoneRenameResponse } from '../../shared/phone'
import type { PhoneAccess } from './phoneAccess'
import type { PhoneDevices } from './PhoneDevices'
import type { PhoneDock } from './phoneDock'
import type { PhonePush } from './PhonePush'
import { handlePhoneFile, isPhoneFilePath, type PhoneFilesDeps } from './phoneFiles'
import { readBody, readJson, send } from './PhoneServer'
import type { ChatSender } from '../ConversationService'

/**
 * The phone's REST routes after access was granted (PhoneServer). Chat calls the same
 * ConversationService functions the Electron Chat view calls over IPC — in this process,
 * never through the Control API port. Everything that types into a session needs the
 * `drive` role, and is written to the session's event log as from the phone.
 */

/** The Chat service, as the Electron IPC handlers call it. */
export interface PhoneConversation {
    getConversation(sessionId: string, limit?: number): Promise<ConversationSnapshot>
    /**
     * `from`: who sends it — `deps.owner` (a disconnected device's queued messages are dropped by it)
     * and `stillAllowed`, asked again right before any key goes (F02)
     */
    send(sessionId: string, text: string, from?: ChatSender, options?: ChatSendOptions): Promise<ChatSendResult>
    placeDraftInTerminal(sessionId: string, text: string, from?: ChatSender): Promise<DraftToTerminalResult>
    takeTerminalDraft(sessionId: string, from?: ChatSender): Promise<DraftFromTerminalResult>
    cancelQueued(sessionId: string): void
    discardQueued(sessionId: string, id: string): boolean
    sendQueuedNow(sessionId: string, id: string, from?: ChatSender): Promise<ChatSendResult>
    interrupt(sessionId: string, from?: ChatSender): Promise<InterruptResult>
    answerPrompt(sessionId: string, answer: PromptAnswer, from?: ChatSender): Promise<PromptAnswerResult>
    /** «Fork into a new session»: opens a session on the Mac, so it is a drive device's action */
    fork(sessionId: string, request: ChatForkRequest, from?: ChatSender): Promise<ChatForkResult>
    getImage(sessionId: string, ref: string): Promise<string | null>
    getToolOutput(sessionId: string, ref: string): Promise<string | null>
    listCommands(sessionId: string): ChatCommand[]
    listBackgroundTasks(sessionId: string): Promise<BackgroundTaskList>
    mentionedPaths(sessionId: string): Promise<{ paths: ReadonlySet<string>; cwd?: string }>
}

export interface PhoneApiDeps {
    access: Extract<PhoneAccess, { level: 'full' }>
    /** `tailscale:<login>` / `device:<id>` — who alerts this request turns on belong to */
    owner: string
    devices: PhoneDevices
    push: PhonePush
    listSessions(): PhoneSessionsResponse
    sessionExists(id: string): boolean
    /** the Artifact Dock list; absent, this Mac has none as far as the phone can tell */
    dock?: Pick<PhoneDock, 'installed' | 'read' | 'docFor'>
    conversation: PhoneConversation
    saveAttachment(name: string, bytes: Uint8Array): AttachResult
    /** screen text leaving the Mac goes through maskSecrets */
    maskLine(text: string): string
    /** the session's event log: «phone» + what happened (never the text itself) */
    recordPhoneInput(sessionId: string, detail: string): void
    /** Settings shows how many devices turned alerts on */
    onStateChange(): void
    /**
     * `access` was judged when the headers arrived. A body can take its time: the device may be
     * revoked (or the phone switched off) before it ends — ask again before acting on it
     * (ovis composer.ts:273,335,632 re-authorize between async steps).
     */
    stillAllowed(): boolean
    /** the session's memo pages, first page first (at least one); null for no such session. Absent: no memo route */
    readMemo?(sessionId: string): string[] | null
    /**
     * The sidebar name, as the Control API renames (0a4bdfff): the name the Mac kept, or null for no
     * such session. Absent: no rename route.
     */
    renameSession?(sessionId: string, name: string): string | null
    /** absent: no file routes (phoneFiles.ts) */
    files?: PhoneFilesDeps
    /** a file on its way to a device: stopped if the device is disconnected */
    trackDownload(stop: () => void): () => void
}

function refuseRevoked(res: http.ServerResponse): void {
    send(res, 401, { status: 'rejected', reason: 'revoked', error: 'revoked', message: 'This device was disconnected from the Mac.' })
}

const DRIVE_ONLY = new Set(['send', 'draft-to-terminal', 'draft-from-terminal', 'cancel-queued', 'discard-queued', 'send-queued-now', 'interrupt', 'answer', 'attach', 'fork'])

export async function handlePhoneApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: PhoneApiDeps): Promise<void> {
    const path = url.pathname
    const method = req.method ?? 'GET'

    if (isPhoneFilePath(path) && deps.files) {
        await handlePhoneFile(req, res, url, {
            files: deps.files,
            role: deps.access.role,
            sessionExists: deps.sessionExists,
            mentionedPaths: (id) => deps.conversation.mentionedPaths(id),
            ...(deps.dock ? { dock: deps.dock } : {}),
            stillAllowed: deps.stillAllowed,
            trackDownload: deps.trackDownload
        })
        return
    }

    if (path === PHONE_API.sessions && method === 'GET') {
        send(res, 200, deps.listSessions())
        return
    }

    // A view-only device reads it too: it already sees terminals and chats. Nothing in the request reaches the socket.
    if (path === PHONE_API.dock && method === 'GET') {
        const list = (await deps.dock?.read()) ?? null
        if (!deps.stillAllowed()) return refuseRevoked(res)
        if (list) send(res, 200, list)
        else send(res, 404, { error: 'dock_not_installed' })
        return
    }

    if (path === PHONE_API.pushSubscribe && method === 'POST') {
        const body = await readJson(req)
        // a revoked device must not leave alerts behind for itself
        if (!deps.stillAllowed()) return refuseRevoked(res)
        const ok = deps.push.subscribe(body?.subscription, deps.owner)
        if (ok) deps.onStateChange()
        send(res, ok ? 200 : 400, ok ? { status: 'subscribed' } : { error: 'bad_subscription' })
        return
    }
    if (path === PHONE_API.pushUnsubscribe && method === 'POST') {
        const body = await readJson(req)
        deps.push.unsubscribe(body?.endpoint)
        deps.onStateChange()
        send(res, 200, { status: 'unsubscribed' })
        return
    }
    if (path === PHONE_API.pushTest && method === 'POST') {
        send(res, 200, await deps.push.test())
        return
    }

    // The memo pad, read-only (84188aa0). A view-only device reads it too, as it reads the chat.
    const memo = /^\/api\/phone\/memo\/([^/]+)$/.exec(path)
    if (memo && method === 'GET' && deps.readMemo) {
        const pages = deps.readMemo(decodeURIComponent(memo[1]))
        if (!deps.stillAllowed()) return refuseRevoked(res)
        if (!pages) {
            send(res, 404, { error: 'unknown_session' })
            return
        }
        const body: PhoneMemoResponse = { pages: pages.map((page) => page.split('\n').map((line) => deps.maskLine(line)).join('\n')) }
        send(res, 200, body)
        return
    }

    // A label on the Mac's sidebar, not input to the terminal — but it changes the Mac: drive devices only
    const rename = /^\/api\/phone\/rename\/([^/]+)$/.exec(path)
    if (rename && method === 'POST' && deps.renameSession) {
        if (deps.access.role !== 'drive') {
            send(res, 403, { error: 'view_only', message: 'This device can only watch. Pair it again with "Can type" to rename.' })
            return
        }
        const sessionId = decodeURIComponent(rename[1])
        const body = await readJson(req)
        if (!deps.stillAllowed()) return refuseRevoked(res)
        const name = typeof body?.name === 'string' ? body.name.trim() : ''
        if (!name) {
            send(res, 400, { error: 'empty_name', message: 'A session needs a name.' })
            return
        }
        const kept = deps.renameSession(sessionId, name)
        if (kept === null) {
            send(res, 404, { error: 'unknown_session' })
            return
        }
        deps.recordPhoneInput(sessionId, 'renamed the session')
        const reply: PhoneRenameResponse = { name: kept }
        send(res, 200, reply)
        return
    }

    const chat = /^\/api\/phone\/chat\/([^/]+)\/([a-z-]+)$/.exec(path)
    if (chat) {
        const sessionId = decodeURIComponent(chat[1])
        const action = chat[2]
        if (!deps.sessionExists(sessionId)) {
            send(res, 404, { error: 'unknown_session' })
            return
        }
        if (DRIVE_ONLY.has(action) && deps.access.role !== 'drive') {
            send(res, 403, { error: 'view_only', message: 'This device can only watch. Pair it again with "Can type" to send.' })
            return
        }
        await handleChat(req, res, url, sessionId, action, method, deps)
        return
    }

    send(res, 404, { error: 'not_found' })
}

async function handleChat(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    sessionId: string,
    action: string,
    method: string,
    deps: PhoneApiDeps
): Promise<void> {
    const c = deps.conversation
    if (method === 'GET') {
        switch (action) {
            case 'conversation': {
                const limit = Number(url.searchParams.get('limit'))
                const snapshot = await c.getConversation(sessionId, Number.isFinite(limit) && limit > 0 ? limit : undefined)
                send(res, 200, maskSnapshot(snapshot, deps.maskLine))
                return
            }
            case 'image':
                send(res, 200, { image: await c.getImage(sessionId, url.searchParams.get('ref') ?? '') })
                return
            case 'tool-output':
                send(res, 200, { output: await c.getToolOutput(sessionId, url.searchParams.get('ref') ?? '') })
                return
            case 'commands':
                send(res, 200, { commands: c.listCommands(sessionId) })
                return
            case 'background': {
                // a command's title is the command itself when it has no description: masked as the chat is
                const list = await c.listBackgroundTasks(sessionId)
                send(res, 200, { ...list, tasks: list.tasks.map((task) => ({ ...task, title: deps.maskLine(task.title) })) })
                return
            }
        }
        send(res, 404, { error: 'not_found' })
        return
    }
    if (method !== 'POST') {
        send(res, 405, { error: 'method' })
        return
    }
    if (action === 'attach') {
        const bytes = await readBody(req, MAX_ATTACH_BYTES)
        if (!deps.stillAllowed()) return refuseRevoked(res)
        if (!bytes) {
            send(res, 413, { status: 'rejected', reason: 'too_large', message: `Files are limited to ${MAX_ATTACH_BYTES / 1024 / 1024} MB.` })
            return
        }
        const name = url.searchParams.get('name') || 'phone-photo'
        const result = deps.saveAttachment(name, new Uint8Array(bytes))
        if (result.status === 'attached') deps.recordPhoneInput(sessionId, 'attached a file')
        send(res, 200, result)
        return
    }
    const body = (await readJson(req)) ?? {}
    if (!deps.stillAllowed()) return refuseRevoked(res)
    // the service waits (flushes, its lane, the queue): it asks again before typing
    const sender: ChatSender = { origin: deps.owner, allowed: () => deps.stillAllowed() }
    switch (action) {
        case 'send': {
            const text = typeof body.text === 'string' ? body.text : ''
            // «Clear and send» (C-1): only the text the refusal showed; main checks the box still holds it
            const clearDraft = typeof body.clearDraft === 'string' ? body.clearDraft : undefined
            const result = await c.send(sessionId, text, sender, clearDraft !== undefined ? { clearDraft } : undefined)
            if (result.status !== 'rejected') deps.recordPhoneInput(sessionId, `chat message ${result.status} (${text.length} chars)`)
            send(res, 200, result)
            return
        }
        case 'draft-to-terminal': {
            const text = typeof body.text === 'string' ? body.text : ''
            const result = await c.placeDraftInTerminal(sessionId, text, sender)
            if (result.status === 'placed') deps.recordPhoneInput(sessionId, `chat draft put in the terminal input (${text.length} chars, no Enter)`)
            send(res, 200, result)
            return
        }
        case 'draft-from-terminal': {
            const result = await c.takeTerminalDraft(sessionId, sender)
            if (result.status === 'moved') deps.recordPhoneInput(sessionId, 'terminal draft moved to the chat')
            send(res, 200, result)
            return
        }
        case 'cancel-queued':
            c.cancelQueued(sessionId)
            send(res, 200, { status: 'ok' })
            return
        case 'discard-queued': {
            // the receipt Edit waits for: was it still queued (ovis useComposerSends.ts:195 discarded receipt)
            const discarded = typeof body.id === 'string' ? c.discardQueued(sessionId, body.id) : false
            send(res, 200, { status: 'ok', discarded })
            return
        }
        case 'send-queued-now': {
            const result = typeof body.id === 'string' ? await c.sendQueuedNow(sessionId, body.id, sender) : { status: 'rejected', reason: 'empty', message: 'No message.' }
            if (result.status === 'sent') deps.recordPhoneInput(sessionId, 'queued chat message sent now')
            send(res, 200, result)
            return
        }
        case 'interrupt': {
            const result = await c.interrupt(sessionId, sender)
            if (result.status === 'stopped') deps.recordPhoneInput(sessionId, 'stopped the turn (Esc)')
            send(res, 200, result)
            return
        }
        case 'fork': {
            const request = body.request as ChatForkRequest | undefined
            if (!request || typeof request !== 'object') {
                send(res, 400, { status: 'rejected', reason: 'failed', message: 'No fork request.' })
                return
            }
            const result = await c.fork(sessionId, request, sender)
            if (result.status === 'forked') deps.recordPhoneInput(sessionId, `forked into a new session (${request.scope === 'excerpt' ? 'excerpt' : 'whole conversation'})`)
            send(res, 200, result)
            return
        }
        case 'answer': {
            const answer = body.answer as PromptAnswer | undefined
            if (!answer || typeof answer.signature !== 'string') {
                send(res, 400, { status: 'rejected', reason: 'bad_answer', message: 'No answer.' })
                return
            }
            const result = await c.answerPrompt(sessionId, answer, sender)
            if (result.status === 'answered') deps.recordPhoneInput(sessionId, 'answered a question card')
            send(res, 200, result)
            return
        }
    }
    send(res, 404, { error: 'not_found' })
}

/**
 * The transcript is what the agent and the person wrote — the Chat view shows it as is.
 * The question card is read off the screen: its words go through maskSecrets like a
 * report's lines. The signature stays as main computed it, so an answer still matches —
 * it is a hash of the unmasked words (promptScreen.ts), so it carries none of them.
 */
export function maskSnapshot(snapshot: ConversationSnapshot, maskLine: (text: string) => string): ConversationSnapshot {
    if (!snapshot.prompt) return snapshot
    const prompt: PromptMenu = {
        ...snapshot.prompt,
        question: maskLine(snapshot.prompt.question),
        context: snapshot.prompt.context.map(maskLine),
        options: snapshot.prompt.options.map((option) => ({
            ...option,
            label: maskLine(option.label),
            ...(option.description ? { description: maskLine(option.description) } : {})
        }))
    }
    return { ...snapshot, prompt }
}
