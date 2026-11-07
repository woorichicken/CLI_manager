import type { ChatSendResult } from '../../../shared/conversation'
import type { PhoneDocMessage, PhoneDocOpened, PhoneDocTarget } from '../../../shared/phone'
import { PHONE_MAX_COMMENT_CHARS, PHONE_MAX_DOC_STORE_BYTES } from '../../../shared/phone'

/**
 * The pure half of the document view (decision 0011): what a frame may say, what a comment becomes, what a send's answer
 * means, and what this phone keeps. The frame's code is the document's, so nothing it says is taken on trust.
 */

/** A longer message than any of these is not one: the page's code is free to send anything. */
const MAX_LINE = 4096
const VIAS = new Set(['clipboard', 'execCommand', 'download'])
/** More than a comment could hold, less than would hurt to read. Past this `doc-comment` is taken and Send says why it cannot. */
const MAX_TEXT = PHONE_MAX_COMMENT_CHARS * 4

const line = (value: unknown): string | null => (typeof value === 'string' && value.length <= MAX_LINE ? value : null)

export function parseDocMessage(data: unknown): PhoneDocMessage | null {
    if (!data || typeof data !== 'object') return null
    const message = data as Record<string, unknown>
    switch (message.type) {
        case 'doc-ready': {
            const title = line(message.title)
            const path = line(message.path)
            return title !== null && path !== null ? { type: 'doc-ready', title, path, seeded: message.seeded === true, hash: line(message.hash) ?? '' } : null
        }
        case 'doc-store':
            return typeof message.value === 'string' ? { type: 'doc-store', value: message.value } : null
        case 'doc-comment':
            return typeof message.text === 'string' && message.text.trim() && message.text.length <= MAX_TEXT && typeof message.via === 'string' && VIAS.has(message.via)
                ? { type: 'doc-comment', text: message.text, via: message.via as 'clipboard' | 'execCommand' | 'download' }
                : null
        case 'doc-link': {
            const url = line(message.url)
            return url !== null && /^(https?:\/\/|mailto:)/i.test(url) ? { type: 'doc-link', url } : null
        }
        case 'doc-open': {
            const path = line(message.path)
            return path !== null && path.startsWith('/') ? { type: 'doc-open', path } : null
        }
        case 'doc-missing':
            return typeof message.count === 'number' && Number.isInteger(message.count) && message.count > 0 ? { type: 'doc-missing', count: message.count } : null
        default:
            return null
    }
}

/** A frame's message counts only if it came from this frame, whose origin is opaque. */
export function fromDocFrame(eventSource: unknown, eventOrigin: string, frameWindow: unknown): boolean {
    return eventSource !== null && eventSource === frameWindow && eventOrigin === 'null'
}

/**
 * The words that go to the session. The path comes first because before-after's and the pin widget's text does not name
 * the file. A kit may quote its own address (html-feedback-kit's `source`): the token stays out of the agent's hands.
 */
export function composeComment(opened: Pick<PhoneDocOpened, 'url' | 'displayRoot'>, rel: string, text: string, origin: string): string {
    const base = opened.url.slice(0, opened.url.lastIndexOf('/') + 1)
    const shown = `${opened.displayRoot}/`
    return `[Phone comment] ${shown}${rel}\n${text.split(`${origin}${base}`).join(shown).split(base).join(shown).trimEnd()}`
}

export const commentTooLong = (text: string): boolean => text.length > PHONE_MAX_COMMENT_CHARS

const AGENT_NAMES: Record<PhoneDocTarget['agent'], string> = { claude: 'Claude', codex: 'Codex' }

export type SendOutcome =
    | { kind: 'done'; notice: string }
    /** the Mac's input box holds text: the chat's own two-press note */
    | { kind: 'busy'; draft: string }
    | { kind: 'refused'; message: string; retry: boolean; pick: boolean; openChat: boolean }

/** What a send's answer means for the sheet. Everything but `done` keeps the words on screen. */
export function sendOutcome(result: ChatSendResult, target: PhoneDocTarget): SendOutcome {
    if (result.status === 'sent') return { kind: 'done', notice: `Sent to ${target.name}` }
    if (result.status === 'queued') return { kind: 'done', notice: `${AGENT_NAMES[target.agent]} is working — it gets this when the turn ends.` }
    const refused = (retry: boolean, pick = false, openChat = false, message = result.message): SendOutcome => ({ kind: 'refused', message, retry, pick, openChat })
    switch (result.reason) {
        case 'awaiting_input':
            return refused(true, false, true, 'The agent is asking a question. Answer it, then send this again.')
        case 'input_busy':
            return result.draft !== undefined ? { kind: 'busy', draft: result.draft } : refused(true)
        // already typed, and Enter did not take: sending again would type it twice
        case 'not_submitted':
            return refused(false, false, true, 'The words are in the terminal’s input box but did not send. Press Enter there.')
        case 'no_agent':
        case 'exited':
        case 'not_running':
        case 'unknown_session':
        case 'conversation_changed':
            return refused(true, true)
        default:
            return refused(false)
    }
}

// ---------------------------------------------------------------------------
// What this phone keeps of a document's comments: its own localStorage, because the frame has none
// ---------------------------------------------------------------------------

const STORE_PREFIX = 'phone-doc-store:'
const STORE_INDEX = 'phone-doc-store-index'
const STORE_DOCUMENTS = 50

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>

/** A browser that blocks site data throws on the object itself, before any call could be caught. */
export function phoneDocStorage(): Storage | null {
    try {
        return window.localStorage
    } catch {
        return null
    }
}

/** A page's place: its folder and name, so it is the same page opened from the chat or reached by a link. */
export const docStoreKey = (folderKey: string, rel: string): string => `${folderKey}:${rel}`

export const storeBytes = (value: string): number => new TextEncoder().encode(value).length

/** What the frame starts with; empty when nothing was kept or the phone's storage is unavailable. */
export function readDocStore(storeKey: string, storage: Storage | null): string {
    try {
        return storage?.getItem(STORE_PREFIX + storeKey) ?? ''
    } catch {
        return ''
    }
}

/** False when it could not be kept: too large for the frame's address, or no room on the phone. */
export function keepDocStore(storeKey: string, value: string, storage: Storage | null): boolean {
    if (!storage || storeBytes(value) > PHONE_MAX_DOC_STORE_BYTES) return false
    try {
        storage.setItem(STORE_PREFIX + storeKey, value)
        const index = (JSON.parse(storage.getItem(STORE_INDEX) ?? '[]') as string[]).filter((key) => key !== storeKey)
        index.unshift(storeKey)
        for (const old of index.splice(STORE_DOCUMENTS)) storage.removeItem(STORE_PREFIX + old)
        storage.setItem(STORE_INDEX, JSON.stringify(index))
        return true
    } catch {
        return false
    }
}

/** The fragment is never sent to the server, and the bridge removes it from the frame's address at once. */
export function frameAddress(url: string, seed: string, hash = ''): string {
    if (!seed) return `${url}${hash}`
    return `${url}#seed=${encodeURIComponent(seed)}${hash ? `&hash=${encodeURIComponent(hash)}` : ''}`
}
