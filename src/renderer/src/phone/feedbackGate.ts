// The phone page's feedback gate and what its reports say about where they came from.
// Pure functions (no window, no import.meta) so T84 runs them without a browser.
import type { PhoneMe } from '../../../shared/phone'
import { FEEDBACK_RELAY_ORIGIN } from '../../../shared/types'

/**
 * The widget shows when main says so (`me.feedback`: this Mac has feedback mode on) for a device
 * that may send, and the build carries the ingest URL and key. The page never judges by its own
 * host — behind `adb reverse` it is localhost, which the desktop gate reads as a development build.
 */
export function phoneFeedbackAvailable(me: PhoneMe | null, configured: boolean): boolean {
    return configured && me?.access === 'full' && me.role === 'drive' && me.feedback !== undefined
}

/**
 * The page URL a report carries: the relay origin (the only host the ingest accepts) and which phone
 * screen it came from. The real one is 127.0.0.1 or the Mac's *.ts.net name — the ingest would refuse it,
 * and a tailnet name is not something to hand out.
 */
export function phoneFeedbackPageUrl(sessionId: string | null): string {
    return `${FEEDBACK_RELAY_ORIGIN}/phone?screen=${sessionId ? 'session' : 'list'}`
}

/**
 * `extra` of a phone report. The device is named by the label it paired with; the Mac owner's Tailscale
 * login is an email address and stays out. No cookie, token or pairing key exists on this side to leak.
 */
export function phoneFeedbackExtra({ me, sessionId, lens }: {
    me: PhoneMe | null
    sessionId: string | null
    lens: 'chat' | 'terminal' | null
}): Record<string, unknown> {
    const full = me?.access === 'full' ? me : null
    return {
        surface: 'phone',
        appVersion: full?.feedback?.appVersion ?? 'unknown',
        phoneDevice: full?.via === 'device' ? full.deviceLabel ?? null : null,
        phoneVia: full?.via ?? null,
        phoneSessionId: sessionId,
        phoneView: sessionId ? lens : null
    }
}
