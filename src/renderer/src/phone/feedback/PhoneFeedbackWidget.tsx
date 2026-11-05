// feedback-kit on the phone page — the desktop wiring (components/Feedback/FeedbackWidget.tsx) with the
// phone's transport: reports go through the phone server to main's FeedbackRelay, not over IPC.
// Loaded only once PhoneFeedback lets it through (lazy), as the desktop widget is.
import { useEffect, useMemo, useState } from 'react'
import {
    buildReport, createLassoAdapter, FeedbackQueue, sharedDiagnostics, uuidv4,
    type LassoFetch, type ReportParts
} from '@solhun/feedback-kit-core'
import {
    captureWebScreenshot, createRouteWatcher, createWebStorage, FeedbackKit as Widget,
    webContextProviders, webDiagnosticsOptions
} from '@solhun/feedback-kit-web'
import type { FeedbackRelayResponse, FeedbackTerminalContext } from '../../../../shared/types'
import { PHONE_API } from '../../../../shared/phone'
import { terminalExtra, withTerminalEvents } from '../../components/Feedback/terminalContext'
import { phoneFeedbackExtra, phoneFeedbackPageUrl } from '../feedbackGate'
import type { PhoneFeedbackView } from './PhoneFeedback'

const ENDPOINT = import.meta.env.VITE_DP_FEEDBACK_URL ?? ''
const TOKEN = import.meta.env.VITE_DP_FEEDBACK_KEY ?? ''
const APP_NAME = 'climanager-app'
/** The page lives at `/` with the session in its query; the trail would only repeat it. */
const APP_ROUTE = '/phone'
const fixedRouteWatcher = createRouteWatcher({ location: { pathname: APP_ROUTE } })
/** A report must not wait on the Mac; past this it goes without the terminal. */
const CONTEXT_TIMEOUT_MS = 2000

/**
 * The widget's fetch, sent by main: the phone browser's Origin (127.0.0.1, *.ts.net) is not one the ingest
 * accepts. A thrown error is what the adapter treats as a network failure — it keeps the report and retries.
 */
const relayFetch: LassoFetch = async (url, init) => {
    const response = await fetch(PHONE_API.feedbackRelay, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, method: init.method, headers: init.headers, body: init.body })
    })
    if (!response.ok) throw new Error(`phone relay ${response.status}`)
    const relayed = (await response.json()) as FeedbackRelayResponse
    if (relayed.error) throw new Error(relayed.error)
    return {
        status: relayed.status,
        headers: { get: (name: string) => relayed.headers[name.toLowerCase()] ?? null },
        text: async () => relayed.body
    }
}

/** The viewed session as main sees it (masked lines), or null if the Mac does not answer in time. */
async function loadContext(sessionId: string | null): Promise<FeedbackTerminalContext | null> {
    const query = sessionId ? `?session=${encodeURIComponent(sessionId)}` : ''
    try {
        const response = await fetch(`${PHONE_API.feedbackTerminal}${query}`, {
            credentials: 'same-origin',
            signal: AbortSignal.timeout(CONTEXT_TIMEOUT_MS)
        })
        return response.ok ? ((await response.json()) as FeedbackTerminalContext) : null
    } catch {
        return null
    }
}

export default function PhoneFeedbackWidget({ viewRef }: { viewRef: { current: PhoneFeedbackView } }) {
    const [ready, setReady] = useState(false)

    useEffect(() => {
        if (!ENDPOINT || !TOKEN) return
        // its own calls must not fill the next report's network log (the relay body carries the key)
        sharedDiagnostics.install(webDiagnosticsOptions({
            excludeMatcher: (req) => req.url.startsWith(ENDPOINT) || req.url.includes('/api/phone/feedback/'),
            watchRoutes: fixedRouteWatcher
        }))
        setReady(true)
        return () => sharedDiagnostics.uninstall()
    }, [])

    // Built once: inline props would recreate the widget on every render and drop a half-typed comment.
    const wiring = useMemo(() => {
        if (!ENDPOINT || !TOKEN) return null
        const storage = createWebStorage()
        const sessionId = uuidv4()
        return {
            queue: new FeedbackQueue({ storage, adapter: createLassoAdapter({ endpoint: ENDPOINT, token: TOKEN, fetch: relayFetch }) }),
            createReport: async (parts: ReportParts) => {
                // read at submit time: the session on screen when the person pressed Send
                const view = viewRef.current
                const target = view.sessionId ? { sessionId: view.sessionId, source: 'viewing' as const } : null
                const terminal = await loadContext(view.sessionId)
                return buildReport(parts, {
                    app: APP_NAME,
                    platform: 'web',
                    sessionId,
                    storage,
                    ...webContextProviders(),
                    getUrl: () => phoneFeedbackPageUrl(view.sessionId),
                    getDiagnostics: () => withTerminalEvents(sharedDiagnostics.snapshot(), terminal),
                    extra: { ...phoneFeedbackExtra(view), ...terminalExtra(target, terminal) }
                })
            },
            getPathname: () => APP_ROUTE
        }
    }, [viewRef])

    if (!wiring || !ready) return null
    return (
        <Widget
            queue={wiring.queue}
            createReport={wiring.createReport}
            capture={captureWebScreenshot}
            getPathname={wiring.getPathname}
            // The kit's default: Feedback starts pointing at an element. A tap is a click to the kit
            // (measured on a Galaxy, 11-05): the note sheet sits above the keyboard with its Send in
            // view. The dock's menu keeps «whole screen» for a report about everything.
        />
    )
}
