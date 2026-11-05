import type http from 'http'
import type { FeedbackRelayRequest, FeedbackRelayResponse, FeedbackTerminalContext } from '../../shared/types'
import { PHONE_API } from '../../shared/phone'
import { isAllowedFeedbackUrl } from '../FeedbackRelay'
import type { PhoneAccess } from './phoneAccess'
import { readBody, send } from './PhoneServer'

/**
 * The feedback widget on the phone page: two routes in front of what the desktop widget
 * already uses over IPC.
 *
 *   POST /api/phone/feedback/relay     → FeedbackRelay (the same allowlist: ingest function only)
 *   GET  /api/phone/feedback/terminal  → feedbackTerminalContext (masked recent lines)
 *
 * Why relay: the phone browser's Origin is 127.0.0.1 / *.ts.net, which the Lasso Run ingest
 * refuses (403). Main presents the app's relay origin, as it does for the desktop renderer.
 *
 * Who: a device that may type (`drive`), and only while this Mac has feedback mode on —
 * the same people who see the widget at the Mac. A view-only device gets 403.
 */

/**
 * The relay request the phone sends: the report JSON (its screenshot as base64) wrapped once more.
 * The kit caps a screenshot at 8 MB of base64 (SCREENSHOT_MAX_BASE64_BYTES); diagnostics and the
 * terminal's 200 lines add tens of KB. 15 MB leaves room without letting a phone fill main's memory.
 */
export const PHONE_FEEDBACK_MAX_BYTES = 15 * 1024 * 1024

const ALLOWED_METHODS = new Set(['GET', 'POST'])

export interface PhoneFeedbackDeps {
    /** the renderer said feedback mode is on (FeedbackModeState) */
    enabled(): boolean
    appVersion(): string
    relay(request: FeedbackRelayRequest): Promise<FeedbackRelayResponse>
    terminalContext(sessionId: string | null): Promise<FeedbackTerminalContext>
}

export interface PhoneFeedbackRequest {
    access: Extract<PhoneAccess, { level: 'full' }>
    /** asked again after the body arrived: the device may have been disconnected meanwhile */
    stillAllowed(): boolean
    /** a session id must name one of this Mac's sessions */
    sessionExists(id: string): boolean
}

/** True when the path is one of these routes (answered here, whatever the outcome). */
export function isPhoneFeedbackPath(path: string): boolean {
    return path === PHONE_API.feedbackRelay || path === PHONE_API.feedbackTerminal
}

export async function handlePhoneFeedback(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    feedback: PhoneFeedbackDeps | undefined,
    ctx: PhoneFeedbackRequest
): Promise<void> {
    const path = url.pathname
    const method = req.method ?? 'GET'
    if (ctx.access.role !== 'drive') {
        send(res, 403, { error: 'view_only', message: 'This device can only watch.' })
        return
    }
    if (!feedback?.enabled()) {
        send(res, 403, { error: 'feedback_off', message: 'Feedback mode is off on the Mac.' })
        return
    }

    if (path === PHONE_API.feedbackTerminal && method === 'GET') {
        const session = url.searchParams.get('session')
        const sessionId = session && ctx.sessionExists(session) ? session : null
        send(res, 200, await feedback.terminalContext(sessionId))
        return
    }

    if (path === PHONE_API.feedbackRelay && method === 'POST') {
        const bytes = await readBody(req, PHONE_FEEDBACK_MAX_BYTES)
        if (!bytes) {
            send(res, 413, { error: 'too_large', message: `A report is limited to ${PHONE_FEEDBACK_MAX_BYTES / 1024 / 1024} MB.` })
            return
        }
        if (!ctx.stillAllowed()) {
            send(res, 401, { error: 'revoked', message: 'This device was disconnected from the Mac.' })
            return
        }
        const request = parseRelayRequest(bytes)
        if (!request) {
            send(res, 400, { error: 'bad_request' })
            return
        }
        // FeedbackRelay checks again; refusing here keeps a bad call off main's network entirely
        if (!isAllowedFeedbackUrl(request.url) || !ALLOWED_METHODS.has(request.method.toUpperCase())) {
            send(res, 400, { error: 'not_allowed' })
            return
        }
        // Never log the request: its headers carry the ingest key and its body the report.
        send(res, 200, await feedback.relay(request))
        return
    }

    send(res, 405, { error: 'method' })
}

function parseRelayRequest(bytes: Buffer): FeedbackRelayRequest | null {
    let raw: unknown
    try {
        raw = JSON.parse(bytes.toString('utf8'))
    } catch {
        return null
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = raw as Record<string, unknown>
    if (typeof value.url !== 'string' || typeof value.method !== 'string') return null
    if (value.body !== undefined && typeof value.body !== 'string') return null
    const headers: Record<string, string> = {}
    if (value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)) {
        for (const [name, header] of Object.entries(value.headers as Record<string, unknown>)) {
            if (typeof header === 'string') headers[name] = header
        }
    }
    return { url: value.url, method: value.method, headers, ...(value.body !== undefined ? { body: value.body as string } : {}) }
}
