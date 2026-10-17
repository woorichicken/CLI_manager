import { FEEDBACK_RELAY_ORIGIN, FeedbackRelayRequest, FeedbackRelayResponse } from '../shared/types'

/**
 * Sends the feedback widget's HTTP requests from main.
 *
 * Why not let the renderer fetch: the packaged renderer is loaded from file://, so the browser
 * sends `Origin: null`, which the Lasso Run ingest rejects (403 origin_not_allowed). Node's fetch
 * lets us present FEEDBACK_RELAY_ORIGIN instead, and it also keeps the renderer CSP closed.
 *
 * The relay only reaches the ingest function: anything else would hand the renderer a way to
 * make arbitrary requests from main.
 */

const INGEST_HOST_SUFFIX = '.supabase.co'
// Reports, hint and connection lookups all live under the source's report URL.
const INGEST_PATH_PREFIX = '/functions/v1/dp-agentation-ingest/'
const ALLOWED_METHODS = new Set(['GET', 'POST'])
// The relay decides these; a renderer-supplied value would undo the point of relaying.
const DROPPED_REQUEST_HEADERS = new Set(['origin', 'host', 'cookie', 'referer'])
const RELAY_TIMEOUT_MS = 30_000

export function isAllowedFeedbackUrl(raw: string): boolean {
    let url: URL
    try {
        url = new URL(raw)
    } catch {
        return false
    }
    return url.protocol === 'https:'
        && url.hostname.endsWith(INGEST_HOST_SUFFIX)
        && url.pathname.startsWith(INGEST_PATH_PREFIX)
        && !url.username
        && !url.password
}

function failure(error: string): FeedbackRelayResponse {
    return { status: 0, headers: {}, body: '', error }
}

export async function relayFeedbackRequest(request: FeedbackRelayRequest): Promise<FeedbackRelayResponse> {
    if (!isAllowedFeedbackUrl(request.url)) return failure('url not allowed')
    const method = request.method.toUpperCase()
    if (!ALLOWED_METHODS.has(method)) return failure('method not allowed')

    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value
    }
    headers['Origin'] = FEEDBACK_RELAY_ORIGIN

    try {
        const response = await fetch(request.url, {
            method,
            headers,
            // A GET with a body is rejected by fetch, even an empty one.
            body: method === 'GET' ? undefined : request.body,
            signal: AbortSignal.timeout(RELAY_TIMEOUT_MS)
        })
        const responseHeaders: Record<string, string> = {}
        response.headers.forEach((value, name) => { responseHeaders[name] = value })
        return { status: response.status, headers: responseHeaders, body: await response.text() }
    } catch (error) {
        // Never log the request: its headers carry the ingest key and its body the report.
        return failure(error instanceof Error ? error.name : 'network error')
    }
}
