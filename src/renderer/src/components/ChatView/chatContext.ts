import { createContext, useContext } from 'react'
import type { ChatTransport } from '../../../../shared/conversation'

/** One picture of a gallery the lightbox steps through. */
export interface GalleryImage {
    /** the transcript ref the transport reads it by */
    ref: string
    media_type: string
}

/**
 * What a deep part of the chat (a Markdown answer, a tool row, a picture) needs from the view
 * without threading it through every turn: open a file it names, open pictures full size, read
 * a cut tool output. Null outside a ChatView — parts then draw paths and pictures as text.
 */
export interface ChatActions {
    sessionId: string
    transport: ChatTransport
    /** a path as the agent wrote it (relative to the session's folder, `~/`, `:12` / `#L12` after it) */
    openPath(path: string): void
    /** false where nothing can show a file (a view-only phone): paths stay plain words, not dead buttons (G9) */
    canOpenPaths: boolean
    /** shows the session(s) a `climanager://session/…` link names; absent where nothing can (b2020233) */
    openSessionLink?: (uri: string) => void
    openGallery(images: GalleryImage[], index: number): void
}

export const ChatActionsContext = createContext<ChatActions | null>(null)

export function useChatActions(): ChatActions | null {
    return useContext(ChatActionsContext)
}

/**
 * Commands for one session's Chat view from outside it — the app's keyboard shortcuts. A
 * module bus rather than props: the shortcut handler sits in App, the view deep in a pane.
 */
export type ChatCommandName = 'focus' | 'pageUp' | 'pageDown'

type Listener = (command: ChatCommandName) => void
const listeners = new Map<string, Set<Listener>>()

/** True when a Chat view of that session was there to take it. */
export function sendChatCommand(sessionId: string, command: ChatCommandName): boolean {
    const set = listeners.get(sessionId)
    if (!set || set.size === 0) return false
    for (const listener of set) listener(command)
    return true
}

export function onChatCommand(sessionId: string, listener: Listener): () => void {
    let set = listeners.get(sessionId)
    if (!set) {
        set = new Set()
        listeners.set(sessionId, set)
    }
    set.add(listener)
    return () => {
        set!.delete(listener)
        if (set!.size === 0) listeners.delete(sessionId)
    }
}

/** Images already read, by session and ref: a picture scrolled past and back is not read again. */
const imageCache = new Map<string, string | null>()
const IMAGE_CACHE_LIMIT = 60

export async function loadChatImage(transport: ChatTransport, sessionId: string, ref: string): Promise<string | null> {
    const key = `${sessionId}\0${ref}`
    if (imageCache.has(key)) return imageCache.get(key) ?? null
    const url = await transport.getImage(sessionId, ref).catch(() => null)
    imageCache.set(key, url)
    if (imageCache.size > IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value!)
    return url
}

export function cachedChatImage(sessionId: string, ref: string): string | null | undefined {
    return imageCache.get(`${sessionId}\0${ref}`)
}
