// Feedback widget gate — attach type `dev+url` (feedback-ui-bootstrap/references/attach-types.md).
//
// Development builds (`pnpm dev`, served from localhost) always show the widget. The packaged
// app shows it only after someone enters the password in Settings > Feedback; this machine then
// remembers it. Everyone else never even loads the widget code.
//
// This is a curtain, not a security boundary: the ingest key is a publishable value and the
// ingest itself only accepts the relay origin. The hash may sit in the bundle because the
// password is 24 random characters.
//
// The salt and hash are not written by hand:
//   node <feedback-ui-bootstrap>/scripts/url-gate.mjs check <repo> --app climanager-app \
//     --gate src/renderer/src/utils/feedbackGate.ts
import { FEEDBACK_RELAY_ORIGIN } from '../../../shared/types'

export const FEEDBACK_PASSWORD_SALT = 'climanager-app/feedback/v1'
export const FEEDBACK_PASSWORD_HASH = 'c4436541b855f325081ca21af0f26059b680316bbdba282f874e2d779c6785cf'
export const UNLOCK_STORAGE_KEY = 'climanager-app:feedback-unlocked'

/** Dispatched on `document` to open the password prompt, or to turn feedback mode off when on. */
export const FEEDBACK_TOGGLE_EVENT = 'feedback:toggle'
/** Dispatched on `document` after feedback mode turns on or off, so Settings can redraw. */
export const FEEDBACK_CHANGED_EVENT = 'feedback:changed'

const DEV_HOSTS = ['localhost', '127.0.0.1']

/** True only for the electron-vite dev server. The packaged app runs on file:// (empty hostname). */
export function isDevFeedbackHost(hostname: string): boolean {
    return DEV_HOSTS.includes(hostname)
}

/** Both values are inlined at build time. A build without them has no widget at all. */
export function isFeedbackConfigured(): boolean {
    return Boolean(import.meta.env.VITE_DP_FEEDBACK_URL && import.meta.env.VITE_DP_FEEDBACK_KEY)
}

export async function hashPassword(password: string): Promise<string> {
    const bytes = new TextEncoder().encode(`${FEEDBACK_PASSWORD_SALT}:${password.trim()}`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function isCorrectPassword(password: string): Promise<boolean> {
    return (await hashPassword(password)) === FEEDBACK_PASSWORD_HASH
}

export function readUnlocked(): boolean {
    try {
        return localStorage.getItem(UNLOCK_STORAGE_KEY) === FEEDBACK_PASSWORD_HASH
    } catch {
        return false
    }
}

export function writeUnlocked(unlocked: boolean): void {
    try {
        if (unlocked) localStorage.setItem(UNLOCK_STORAGE_KEY, FEEDBACK_PASSWORD_HASH)
        else localStorage.removeItem(UNLOCK_STORAGE_KEY)
    } catch {
        // Storage can be unavailable; the gate then simply stays locked.
    }
    document.dispatchEvent(new CustomEvent(FEEDBACK_CHANGED_EVENT))
}

/**
 * The page URL a report carries. The ingest wants an HTTP(S) URL on an allowed host, and the
 * real one (file:///Applications/…) would also leak the install path. The window mode is kept
 * because a fullscreen grid and the main window are different screens to whoever triages.
 */
export function feedbackPageUrl(): string {
    const mode = new URLSearchParams(window.location.search).get('mode')
    return `${FEEDBACK_RELAY_ORIGIN}/${mode ? `?mode=${encodeURIComponent(mode)}` : ''}`
}
