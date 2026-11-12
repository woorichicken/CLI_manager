/**
 * The phone page's wire protocol: what the phone server (main, `src/main/phone/`)
 * answers over HTTP and WebSocket, and what the phone page (`src/renderer/src/phone/`)
 * sends. Types only — both sides import them so the two cannot drift.
 *
 * The phone only reads sessions and works in the ones that exist: there is no
 * route that creates, deletes or renames a session, and none that resizes a pty.
 */

/** What a request may do: `drive` types and answers, `watch` only reads. */
export type PhoneRole = 'drive' | 'watch'

/** How a request got in. */
export type PhoneVia = 'tailscale' | 'device'

export type PhoneRefusal =
    /** the phone connection is switched off in Settings */
    | 'disabled'
    /** a device that is not this Mac's owner and holds no paired-device cookie */
    | 'pairing_required'
    /** Tailscale Funnel: the public internet is never let in */
    | 'funnel'
    /** the request did not come through this Mac (the server listens on 127.0.0.1 only) */
    | 'not_local'
    /** Host or Origin names another site (DNS rebinding, a page on another origin) */
    | 'bad_origin'

/** GET /api/phone/me — who this request is. */
export type PhoneMe =
    | { access: 'full'; role: PhoneRole; via: PhoneVia; login?: string; deviceLabel?: string; push?: PhonePushInfo; feedback?: PhoneFeedbackInfo; quickReplies?: string[]; quickRepliesSet?: boolean; pinLastMessage?: boolean; dock?: true }
    | { access: 'none'; reason: PhoneRefusal }

/** `push` is absent when the Mac's alert key file is malformed: the page shows no bell. */
export interface PhonePushInfo {
    /** VAPID public key (base64url) for `pushManager.subscribe` */
    publicKey: string
}

/**
 * Present only when this Mac shows the feedback widget (its renderer said feedback mode is on, or a
 * development build) and the device may type. The page decides from this alone: behind
 * `adb reverse` its own host is localhost too, so it cannot tell a development build by itself.
 */
export interface PhoneFeedbackInfo {
    /** the Mac app's version, carried in each report's `extra` */
    appVersion: string
}

/** The status dot of a session row, read from its screen like the sidebar's. */
export type PhoneSessionState = 'working' | 'waiting' | 'idle' | 'exited' | 'stopped'

export interface PhoneSession {
    id: string
    name: string
    workspaceId: string
    /** shown dim on the row, as the Mac's All sessions list labels each row with its workspace */
    workspaceName: string
    /** Claude Code / Codex: opens in Chat */
    agent: 'claude' | 'codex' | null
    state: PhoneSessionState
    /** the question on screen when `waiting` — masked like a feedback report's lines */
    question?: string
    /** the All sessions folder it sits in */
    sessionFolderId?: string
    pinned?: boolean
    /** how many memo pages hold something; absent when the memo is empty (84188aa0) */
    memoPages?: number
}

/** GET /api/phone/memo/<sessionId> — the session's memo pad, first page first, read-only (84188aa0) */
export interface PhoneMemoResponse {
    /** always at least one; lines go through maskSecrets as every text leaving the Mac does */
    pages: string[]
}

/**
 * GET /api/phone/sessions — the Mac sidebar's «All sessions» (List), top to bottom.
 * main orders it with the sidebar's own functions (`sessionsInSidebarOrder` →
 * `orderForAllSessions` → `groupBySessionFolder`), so the phone cannot drift from the Mac.
 */
export interface PhoneSessionsResponse {
    /** one list, in the Mac's order: each session folder's sessions, then the rest — pinned first, then recently viewed */
    sessions: PhoneSession[]
    /** the All sessions folders, in order — the phone marks where each one's sessions start */
    sessionFolders: Array<{ id: string; name: string }>
}

/** One document in the Artifact Dock, as the extension's side panel lists it. */
export interface PhoneDockItem {
    /** opaque: the extension's own key holds the file's path, which stays on the Mac */
    key: string
    title: string
    /** the folder, shortened to `~` by the extension (or «Claude artifact») */
    sub: string
    at: number
    pinned: boolean
    /** the file was deleted: shown, not opened */
    missing: boolean
    kind: 'file' | 'link'
    /** links only, and only https on claude.ai / claude.site. A file's absolute path never reaches the phone. */
    url?: string
    /** the session that last opened it with `artifact-open` */
    session: { id: string; name: string } | null
    /** it names a session that has since closed */
    sessionGone?: true
}

/**
 * GET /api/phone/dock — the extension's list in its own order: the page draws it as it comes, with no sort of
 * its own, so it cannot drift from the side panel. A 404 `dock_not_installed` means no Dock on this Mac.
 */
export interface PhoneDockResponse {
    /** `chrome_off`: Chrome or the extension is not running · `outdated`: no answer, probably older than 0.7.0 · `error`: an unreadable answer */
    status: 'live' | 'chrome_off' | 'outdated' | 'error'
    /** when `open` and `closed` were read; the last list stays (in memory) when the status is not `live` */
    asOf: number | null
    open: PhoneDockItem[]
    closed: PhoneDockItem[]
}

/** POST /api/phone/pair — a code the Mac shows in Settings › Phone. */
export interface PhonePairRequest {
    code: string
    /** what the device calls itself in the Mac's device list */
    label: string
}

export type PhonePairResult =
    | { status: 'paired'; role: PhoneRole }
    | { status: 'rejected'; reason: 'wrong_code' | 'no_code' | 'disabled' }

/** POST /api/phone/push/subscribe — the browser's PushSubscription.toJSON(). */
export interface PhonePushSubscription {
    endpoint: string
    keys: { p256dh: string; auth: string }
}

/** What a Web Push carries; the service worker shows it and opens `url` on a tap. */
export interface PhonePushPayload {
    title: string
    body: string
    /** `/?session=<id>&view=chat` */
    url: string
    /** collapses repeats of the same session on the lock screen */
    tag: string
}

export type PhoneTestPushResult =
    | { status: 'sent'; devices: number }
    | { status: 'none'; message: string }
    | { status: 'failed'; message: string }

// ---------------------------------------------------------------------------
// Terminal WebSocket — /api/phone/terminal?session=<id>
//
// Invariant 6, as a renderer view attaches: the first message is the screen
// mirror's snapshot (with the size it was taken at), and only output that came
// after it follows. The phone draws at the Mac's size; it never asks for another.
// ---------------------------------------------------------------------------

export type PhoneTerminalServerMessage =
    /** history to draw first, at this size */
    | { type: 'snapshot'; data: string; cols: number; rows: number; role: PhoneRole }
    /** live pty output, in order */
    | { type: 'output'; data: string }
    /** the Mac resized the pty (its window); the phone redraws at the new size */
    | { type: 'size'; cols: number; rows: number }
    | { type: 'exit' }
    /** a message the server refused; the connection stays open */
    | { type: 'error'; reason: 'view_only' | 'resize_not_allowed' | 'bad_message' | 'too_large'; message: string }

export type PhoneTerminalClientMessage =
    /** keys and text for the pty, as the terminal would send them */
    | { type: 'input'; data: string }

/** The longest single input message the server takes (a pasted paragraph is fine). */
export const PHONE_MAX_INPUT_LENGTH = 16_000

// ---------------------------------------------------------------------------
// Files — GET /api/phone/file?session=<id>&path=<absolute path> · /api/phone/file/raw (+ &download=1)
//
// A phone asks for a path its chat shows as a link, and the Mac judges it (decision 0010).
// ---------------------------------------------------------------------------

/** Larger text and pictures download instead of showing (the Mac's previews stop at the same sizes). */
export const PHONE_TEXT_PREVIEW_BYTES = 500_000
export const PHONE_IMAGE_PREVIEW_BYTES = 10_000_000
/** Larger files are refused: a phone on mobile data should not start one by accident. */
export const PHONE_MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024

export type PhoneFileRefusal =
    | 'bad_path'
    /** the device was disconnected while this was being judged */
    | 'revoked'
    | 'view_only'
    /** `Sec-Fetch-Site` says another site asked */
    | 'cross_site'
    /** this session's chat shows no link to it */
    | 'not_mentioned'
    | 'outside_roots'
    | 'protected'
    /** the system said no (permissions, macOS privacy) */
    | 'unreadable'
    | 'unknown_session'
    | 'not_found'
    /** a folder, a FIFO, a device */
    | 'not_a_file'
    | 'too_large'

export type PhoneFileInfo = {
    status: 'ok'
    name: string
    size: number
    /** ISO 8601 */
    modifiedAt: string
    mime: string
    /** the bytes: this route's query, judged again from the first step */
    rawUrl: string
} & (
    | { kind: 'image' }
    /** the words with secrets hidden; `language` is the extension, a code fence's word */
    | { kind: 'text' | 'html'; content: string; maskedValues: number; language: string | null }
    | { kind: 'download'; why: 'type' | 'binary' | 'too_large_to_preview' }
)

export interface PhoneFileRefused {
    status: 'refused'
    reason: PhoneFileRefusal
    /** the one line the panel shows */
    message: string
}

// ---------------------------------------------------------------------------
// Documents — POST /api/phone/doc/open · GET /doc/<token>/<path>
//
// An HTML report opens in a sandboxed frame, and its comments reach a session only through the phone page's own
// sheet (decision 0011). The frame talks to the page and to nothing else.
// ---------------------------------------------------------------------------

/** Where a document and the files beside it are served: outside `/api/`, whose gate a sandboxed page's requests cannot pass. */
export const PHONE_DOC_PREFIX = '/doc/'
/** Both the frame's attribute and the response's header. Never `allow-same-origin`: the page's code would be the phone page's. */
export const PHONE_DOC_SANDBOX = 'allow-scripts allow-forms allow-modals'
/** A before-after review holds its pictures: the largest measured was 42.6 MB. */
export const PHONE_MAX_DOC_BYTES = 64 * 1024 * 1024
/** Below what `readJson` takes (256 KB) at three bytes a character: past that the send reads as an empty message. */
export const PHONE_MAX_COMMENT_CHARS = 50_000
/** What this phone keeps of one document's comments. It travels in the frame's address: 256 KB fits, 1 MB does not (measured). */
export const PHONE_MAX_DOC_STORE_BYTES = 256 * 1024

export type PhoneDocRefusal = PhoneFileRefusal | 'not_html'

/** The session a document's comments go to. */
export interface PhoneDocTarget {
    id: string
    name: string
    agent: 'claude' | 'codex'
}

/** POST /api/phone/doc/open `{ session, path }` */
export interface PhoneDocOpened {
    status: 'ok'
    /** `/doc/<token>/<name>`: the frame's address */
    url: string
    /** the page's own `<title>`, or its file name */
    title: string
    /** the folder, `~` for home: what a comment names */
    displayRoot: string
    /** the document inside that folder */
    rel: string
    size: number
    /** ISO 8601 */
    modifiedAt: string
    /** the folder: this phone files a page's comments under this and the page's name, however the page was reached */
    storeKey: string
    /** null: the session has no agent. The sheet asks which one */
    target: PhoneDocTarget | null
    /** the file's bytes, for saving it (D1's raw route) */
    rawUrl: string
}

export interface PhoneDocRefused {
    status: 'refused'
    reason: PhoneDocRefusal
    message: string
}

/** What a document's frame tells the phone page, and all it can. The page sends nothing back. */
export type PhoneDocMessage =
    /**
     * A page loaded in the frame; `path` is inside the document's folder. `seeded`: it came with its kept comments. A page
     * reached by a link or a script comes without, and is loaded again with them; `hash` is its place on the page.
     */
    | { type: 'doc-ready'; title: string; path: string; seeded: boolean; hash: string }
    /** the page's storage changed */
    | { type: 'doc-store'; value: string }
    /** the page copied or saved its comments */
    | { type: 'doc-comment'; text: string; via: 'clipboard' | 'execCommand' | 'download' }
    /** a link to the web */
    | { type: 'doc-link'; url: string }
    /** a link to a file of the Mac, judged like any other */
    | { type: 'doc-open'; path: string }
    /** how many pictures, styles or scripts failed to load so far */
    | { type: 'doc-missing'; count: number }

/** Phone server routes, so the page and the server spell them the same. */
export const PHONE_API = {
    me: '/api/phone/me',
    pair: '/api/phone/pair',
    sessions: '/api/phone/sessions',
    dock: '/api/phone/dock',
    terminal: '/api/phone/terminal',
    pushSubscribe: '/api/phone/push/subscribe',
    pushUnsubscribe: '/api/phone/push/unsubscribe',
    pushTest: '/api/phone/push/test',
    /** `/api/phone/chat/<sessionId>/<action>` */
    chat: '/api/phone/chat',
    /** what a file is and how to draw it (`phoneFiles.ts`) */
    file: '/api/phone/file',
    /** a file's bytes */
    fileRaw: '/api/phone/file/raw',
    /** POST: a token for one document (`phoneDoc.ts`) */
    docOpen: '/api/phone/doc/open',
    /** POST: one HTTP request of the feedback widget, sent by main's FeedbackRelay */
    feedbackRelay: '/api/phone/feedback/relay',
    /** GET `?session=<id>`: the terminal a report is about, as the desktop widget gets it over IPC */
    feedbackTerminal: '/api/phone/feedback/terminal',
    /** GET `/api/phone/memo/<sessionId>`: the session's memo pages */
    memo: '/api/phone/memo'
} as const
