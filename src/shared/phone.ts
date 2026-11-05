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
    | { access: 'full'; role: PhoneRole; via: PhoneVia; login?: string; deviceLabel?: string; push?: PhonePushInfo; feedback?: PhoneFeedbackInfo }
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

/** Phone server routes, so the page and the server spell them the same. */
export const PHONE_API = {
    me: '/api/phone/me',
    pair: '/api/phone/pair',
    sessions: '/api/phone/sessions',
    terminal: '/api/phone/terminal',
    pushSubscribe: '/api/phone/push/subscribe',
    pushUnsubscribe: '/api/phone/push/unsubscribe',
    pushTest: '/api/phone/push/test',
    /** `/api/phone/chat/<sessionId>/<action>` */
    chat: '/api/phone/chat',
    /** POST: one HTTP request of the feedback widget, sent by main's FeedbackRelay */
    feedbackRelay: '/api/phone/feedback/relay',
    /** GET `?session=<id>`: the terminal a report is about, as the desktop widget gets it over IPC */
    feedbackTerminal: '/api/phone/feedback/terminal'
} as const
