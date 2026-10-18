// feedback-kit wiring, following its README ("web"). Loaded only once FeedbackGate lets it through.
import { useEffect, useMemo, useRef, useState } from 'react'
import {
    buildReport, createLassoAdapter, FeedbackQueue, sharedDiagnostics, uuidv4,
    type LassoFetch, type ReportParts
} from '@solhun/feedback-kit-core'
import {
    captureWebScreenshot, createRouteWatcher, createWebStorage, FeedbackKit as Widget,
    webContextProviders, webDiagnosticsOptions
} from '@solhun/feedback-kit-web'
import { feedbackPageUrl } from '../../utils/feedbackGate'
import { loadTerminalContext, resolveTerminalTarget, sessionOfNode, terminalExtra, withTerminalEvents } from './terminalContext'

const ENDPOINT = import.meta.env.VITE_DP_FEEDBACK_URL ?? ''
const TOKEN = import.meta.env.VITE_DP_FEEDBACK_KEY ?? ''
const APP_NAME = 'climanager-app'
// The renderer is one page loaded from file://. Its real pathname is the install path
// (/Applications/…/app.asar/…, or a home folder), which would leak into every report's route trail.
const APP_ROUTE = '/'
const fixedRouteWatcher = createRouteWatcher({ location: { pathname: APP_ROUTE } })

/**
 * The widget's fetch, sent by main (src/main/FeedbackRelay.ts): from file:// the browser would
 * send `Origin: null`, which the ingest rejects. A thrown error is what the adapter treats as
 * a network failure — it keeps the report queued and retries.
 */
const relayFetch: LassoFetch = async (url, init) => {
    const response = await window.api.feedbackRelay({
        url,
        method: init.method,
        headers: init.headers,
        body: init.body
    })
    if (response.error) throw new Error(response.error)
    return {
        status: response.status,
        headers: { get: (name: string) => response.headers[name.toLowerCase()] ?? null },
        text: async () => response.body
    }
}

export default function FeedbackWidget() {
    const [ready, setReady] = useState(false)
    // Refs, not state: createReport must keep one identity (see below) yet read these late.
    const appVersionRef = useRef('unknown')
    // The widget's own dialog takes focus when it opens, so the terminal in use is remembered beforehand.
    const lastFocusedSessionRef = useRef<string | null>(null)

    useEffect(() => {
        const onFocusIn = (event: FocusEvent): void => {
            const sessionId = sessionOfNode(event.target)
            if (sessionId) lastFocusedSessionRef.current = sessionId
        }
        document.addEventListener('focusin', onFocusIn)
        return () => document.removeEventListener('focusin', onFocusIn)
    }, [])

    useEffect(() => {
        if (!ENDPOINT || !TOKEN) return
        // Diagnostics go in before the widget. Its reports travel over IPC, not fetch, so the
        // matcher only matters if a direct transport ever comes back — then it must not report itself.
        sharedDiagnostics.install(webDiagnosticsOptions({
            excludeMatcher: (req) => req.url.startsWith(ENDPOINT),
            watchRoutes: fixedRouteWatcher
        }))
        window.api.getAppVersion().then((version) => { appVersionRef.current = version }).catch(() => {})
        setReady(true)
        return () => sharedDiagnostics.uninstall()
    }, [])

    // Built once: inline props would recreate the widget on every render and drop a half-typed comment.
    const wiring = useMemo(() => {
        if (!ENDPOINT || !TOKEN) return null
        const storage = createWebStorage()
        const sessionId = uuidv4()
        return {
            queue: new FeedbackQueue({
                storage,
                adapter: createLassoAdapter({ endpoint: ENDPOINT, token: TOKEN, fetch: relayFetch })
            }),
            createReport: async (parts: ReportParts) => {
                // Every report carries the terminal it is about and what happened to it lately.
                // Read at submit time; if main does not answer in time the report goes without it.
                const target = resolveTerminalTarget(parts.element, lastFocusedSessionRef.current)
                const terminal = await loadTerminalContext(target)
                return buildReport(parts, {
                    app: APP_NAME,
                    platform: 'web',
                    sessionId,
                    storage,
                    ...webContextProviders(),
                    // The real URL is file:///…/app.asar/… — not HTTP(S), so the ingest would answer 400.
                    getUrl: feedbackPageUrl,
                    getDiagnostics: () => withTerminalEvents(sharedDiagnostics.snapshot(), terminal),
                    extra: { appVersion: appVersionRef.current, ...terminalExtra(target, terminal) }
                })
            },
            getPathname: () => APP_ROUTE
        }
    }, [])

    if (!wiring || !ready) return null
    return (
        <Widget
            queue={wiring.queue}
            createReport={wiring.createReport}
            capture={captureWebScreenshot}
            getPathname={wiring.getPathname}
            defaultMode="pick"
        />
    )
}
