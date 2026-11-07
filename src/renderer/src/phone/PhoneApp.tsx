import { useCallback, useEffect, useRef, useState } from 'react'
import { Laptop, MessageSquareWarning } from 'lucide-react'
import type { PhoneMe, PhoneSession, PhoneSessionsResponse } from '../../../shared/phone'
import { getMe, getSessions, PhoneApiError } from './api'
import { AlertsMenu } from './AlertsMenu'
import { DropletPill } from './DropletPill'
import { dropletFor, nextSeen, waitingElsewhere, type Droplet, type SeenState } from './droplets'
import { PairScreen } from './PairScreen'
import { openPhoneFeedback, phoneFeedbackConfigured, PhoneFeedback } from './feedback/PhoneFeedback'
import { PhoneSettingsMenu } from './PhoneSettingsMenu'
import { HandoffNoticeToast } from '../components/ChatView/HandoffNoticeToast'
import { parseSessionLink } from '../utils/sessionLink'
import { usePhoneChatSettings } from './phoneChatSettings'
import type { ChatPreferences } from '../../../shared/conversation'
import { phoneFeedbackAvailable } from './feedbackGate'
import { SessionList } from './SessionList'
import { SessionScreen, type SessionLens } from './SessionScreen'
import { reconnectDelay } from './usePhoneTerminal'

/**
 * The phone page: who am I → the session list → one session (Chat | Terminal).
 * Under 768px the list is a drawer (☰, or a swipe from the left edge); wider, it stays
 * beside the session as the Mac's sidebar does. The open session and view live in the
 * address (`?session=…&view=chat`), which is what an alert opens.
 */

const WIDE = '(min-width: 768px)'
const LIST_POLL_MS = 3000
const EDGE_PX = 24
const SWIPE_PX = 60
const LENS_KEY = 'phone-session-lens'

function readRoute(): { sessionId: string | null; view: SessionLens | null } {
    const params = new URLSearchParams(window.location.search)
    const view = params.get('view')
    return { sessionId: params.get('session'), view: view === 'chat' || view === 'terminal' ? view : null }
}

function rememberedLens(sessionId: string): SessionLens | null {
    try {
        const saved = JSON.parse(window.localStorage.getItem(LENS_KEY) ?? '{}') as Record<string, SessionLens>
        return saved[sessionId] ?? null
    } catch {
        return null
    }
}

function rememberLens(sessionId: string, lens: SessionLens): void {
    try {
        const saved = JSON.parse(window.localStorage.getItem(LENS_KEY) ?? '{}') as Record<string, SessionLens>
        saved[sessionId] = lens
        window.localStorage.setItem(LENS_KEY, JSON.stringify(saved))
    } catch {
        // not remembered
    }
}

function useWide(): boolean {
    const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches)
    useEffect(() => {
        const query = window.matchMedia(WIDE)
        const change = (): void => setWide(query.matches)
        query.addEventListener('change', change)
        return () => query.removeEventListener('change', change)
    }, [])
    return wide
}

/** Away from the page this long counts as coming back (the phone slept, another app was in front). */
const AWAY_MS = 5_000
/** «Refreshing…» stays at least this long — a blink would not be read. */
const REFRESH_MIN_MS = 600

export function PhoneApp() {
    const [me, setMe] = useState<PhoneMe | null>(null)
    const [data, setData] = useState<PhoneSessionsResponse | null>(null)
    const [route, setRoute] = useState(readRoute)
    const [drawer, setDrawer] = useState(false)
    const [offline, setOffline] = useState(false)
    /** back on the page after a while away: the list and chat are being read again (e05bf978) */
    const [refreshing, setRefreshing] = useState(false)
    const wide = useWide()
    const chatSettings = usePhoneChatSettings()
    const edge = useRef<{ x: number; y: number } | null>(null)
    const [droplet, setDroplet] = useState<Droplet | null>(null)
    const seen = useRef<Map<string, SeenState> | null>(null)
    const openIdRef = useRef<string | null>(route.sessionId)
    openIdRef.current = route.sessionId
    const alertsRef = useRef(chatSettings.alerts)
    alertsRef.current = chatSettings.alerts
    // turned off with a banner up: it goes, and does not come back when turned on again
    useEffect(() => {
        if (!chatSettings.alerts) setDroplet(null)
    }, [chatSettings.alerts])

    const loadMe = useCallback(() => {
        getMe()
            .then((next) => {
                setMe(next)
                setOffline(false)
            })
            .catch(() => setOffline(true))
    }, [])
    useEffect(loadMe, [loadMe])

    // The first /me failed (the Mac asleep, the phone between networks): try again on a growing wait,
    // and at once when the page or the network comes back — the same rule as the terminal's socket
    // (ovis src/lib/ws.ts). A page that never got /me also never starts the list polling below.
    const unreachable = offline && !me
    useEffect(() => {
        if (!unreachable) return
        let retries = 0
        let timer: number | null = null
        const schedule = (): void => {
            timer = window.setTimeout(() => {
                timer = null
                if (document.visibilityState === 'visible') loadMe()
                retries++
                schedule()
            }, reconnectDelay(retries + 2))
        }
        const now = (): void => {
            if (document.visibilityState === 'visible') loadMe()
        }
        schedule()
        document.addEventListener('visibilitychange', now)
        window.addEventListener('online', now)
        window.addEventListener('pageshow', now)
        return () => {
            if (timer !== null) window.clearTimeout(timer)
            document.removeEventListener('visibilitychange', now)
            window.removeEventListener('online', now)
            window.removeEventListener('pageshow', now)
        }
    }, [unreachable, loadMe])

    // the list, every few seconds while the page is in front
    useEffect(() => {
        if (me?.access !== 'full') return
        let stopped = false
        const load = (): void => {
            if (document.visibilityState !== 'visible') return
            getSessions()
                .then((next) => {
                    if (!stopped) {
                        setData(next)
                        setOffline(false)
                        // another session asked or finished a long turn while this page is open
                        const now = Date.now()
                        const news = dropletFor(seen.current, next.sessions, openIdRef.current, now)
                        seen.current = nextSeen(seen.current, next.sessions, now)
                        if (news && alertsRef.current) setDroplet(news)
                    }
                })
                .catch((error) => {
                    if (stopped) return
                    if (error instanceof PhoneApiError && (error.status === 401 || error.status === 403)) loadMe()
                    else setOffline(true)
                })
        }
        load()
        const timer = window.setInterval(load, LIST_POLL_MS)
        document.addEventListener('visibilitychange', load)
        return () => {
            stopped = true
            window.clearInterval(timer)
            document.removeEventListener('visibilitychange', load)
        }
    }, [me, loadMe])

    // Back after a while away: say so until the list is read again, so the old screen is not taken
    // for the current one (e05bf978 · 24ab5ab1). The chat reads itself again on its own (phoneChatTransport).
    useEffect(() => {
        if (me?.access !== 'full') return
        let hiddenAt: number | null = null
        let stopped = false
        const visibility = (event?: Event): void => {
            if (document.visibilityState === 'hidden') {
                hiddenAt ??= Date.now()
                return
            }
            const away = (hiddenAt !== null && Date.now() - hiddenAt >= AWAY_MS) || (event as PageTransitionEvent | undefined)?.persisted === true
            hiddenAt = null
            if (!away) return
            setRefreshing(true)
            const shown = Date.now()
            getSessions()
                .then((next) => {
                    if (stopped) return
                    setData(next)
                    setOffline(false)
                })
                .catch(() => {
                    if (!stopped) setOffline(true)
                })
                // long enough to be seen, not a flicker
                .finally(() => window.setTimeout(() => !stopped && setRefreshing(false), Math.max(0, REFRESH_MIN_MS - (Date.now() - shown))))
        }
        document.addEventListener('visibilitychange', visibility)
        window.addEventListener('pageshow', visibility)
        return () => {
            stopped = true
            document.removeEventListener('visibilitychange', visibility)
            window.removeEventListener('pageshow', visibility)
        }
    }, [me])

    const navigate = useCallback((sessionId: string | null, view: SessionLens | null, replace = false) => {
        const params = new URLSearchParams()
        if (sessionId) params.set('session', sessionId)
        if (sessionId && view) params.set('view', view)
        const url = params.toString() ? `/?${params}` : '/'
        if (replace) window.history.replaceState(null, '', url)
        else window.history.pushState(null, '', url)
        setRoute({ sessionId, view })
    }, [])

    useEffect(() => {
        const pop = (): void => setRoute(readRoute())
        window.addEventListener('popstate', pop)
        // an alert tapped while this page is open (sw.js posts where to go)
        const fromWorker = (event: MessageEvent): void => {
            const message = event.data as { type?: string; url?: string } | null
            if (message?.type === 'open' && message.url?.startsWith('/')) {
                window.history.pushState(null, '', message.url)
                setRoute(readRoute())
            }
        }
        navigator.serviceWorker?.addEventListener('message', fromWorker)
        return () => {
            window.removeEventListener('popstate', pop)
            navigator.serviceWorker?.removeEventListener('message', fromWorker)
        }
    }, [])

    const closeDroplet = useCallback(() => setDroplet(null), [])

    if (unreachable) {
        return (
            <div className="phone-empty phone-fill" data-testid="phone-unreachable">
                <p>The Mac is not answering. Is CLI Manager running, with Settings › Phone on?</p>
                <p className="phone-unreachable-note">Trying again by itself.</p>
                <button type="button" className="phone-retry" data-testid="phone-retry" onClick={loadMe}>
                    Retry now
                </button>
            </div>
        )
    }
    if (!me) return <div className="phone-empty phone-fill">Connecting to the Mac…</div>
    if (me.access === 'none') return <PairScreen reason={me.reason} onPaired={loadMe} />

    const session = data?.sessions.find((s) => s.id === route.sessionId) ?? null
    const lens: SessionLens = route.view ?? (session ? rememberedLens(session.id) : null) ?? 'chat'
    const open = (next: PhoneSession): void => {
        setDrawer(false)
        navigate(next.id, next.agent ? rememberedLens(next.id) ?? 'chat' : 'terminal')
    }
    // A session link in the chat (b2020233): the phone shows one session, so the first one the link names
    // that this list holds. Refs are full ids or their first 8+ characters, as on the Mac (sessionLink.ts).
    const openSessionLink = (uri: string): void => {
        const refs = parseSessionLink(uri) ?? []
        for (const ref of refs) {
            const target = data?.sessions.find((s) => s.id.toLowerCase().startsWith(ref))
            if (target) return open(target)
        }
    }
    const showList = wide || !session || drawer
    const feedback = phoneFeedbackAvailable(me, phoneFeedbackConfigured())
    const badge = data && chatSettings.alerts ? waitingElsewhere(data.sessions, session?.id ?? null) : 0
    // the Mac's say until this phone chose
    const quickRepliesOn = chatSettings.quickReplies ?? me.quickRepliesSet === true
    const pinLastOn = chatSettings.pinLastMessage ?? me.pinLastMessage === true
    const chatPreferences: ChatPreferences = {
        returnSendsOnTouch: chatSettings.returnSends,
        showQuickReplies: quickRepliesOn,
        quickReplies: me.quickReplies ?? [],
        pinLastMessage: pinLastOn
    }

    return (
        <div
            className={`phone-app ${wide ? 'phone-wide' : 'phone-narrow'}`}
            data-testid="phone-app"
            data-drawer={drawer ? 'open' : 'closed'}
            onTouchStart={(event) => {
                const touch = event.touches[0]
                edge.current = !wide && session && touch.clientX < EDGE_PX ? { x: touch.clientX, y: touch.clientY } : null
            }}
            onTouchMove={(event) => {
                const start = edge.current
                const touch = event.touches[0]
                if (start && touch.clientX - start.x > SWIPE_PX && Math.abs(touch.clientY - start.y) < SWIPE_PX) {
                    setDrawer(true)
                    edge.current = null
                }
            }}
        >
            {showList && (
                <aside className={`phone-sidebar ${!wide && session ? 'phone-drawer' : ''}`} data-testid="phone-sidebar">
                    <div className="phone-sidebar-head">
                        <Laptop size={16} />
                        <span className="phone-sidebar-title">CLI Manager</span>
                        <span className="phone-who" data-testid="phone-who">
                            {me.via === 'tailscale' ? me.login : me.deviceLabel}
                            {me.role === 'watch' ? ' · view only' : ''}
                        </span>
                        {feedback && (
                            <button
                                type="button"
                                className="phone-icon-button"
                                aria-label="Feedback"
                                title="Send feedback about this screen"
                                data-testid="phone-feedback-button"
                                onClick={() => {
                                    // the report captures the screen: the session, not the drawer over it
                                    setDrawer(false)
                                    void openPhoneFeedback()
                                }}
                            >
                                <MessageSquareWarning size={17} />
                            </button>
                        )}
                        {me.role === 'drive' && <PhoneSettingsMenu quickReplies={me.quickReplies ?? []} quickRepliesOn={quickRepliesOn} pinLastOn={pinLastOn} />}
                        {me.push && <AlertsMenu publicKey={me.push.publicKey} />}
                    </div>
                    {offline && <div className="phone-offline">Reconnecting to the Mac…</div>}
                    {!offline && refreshing && (
                        <div className="phone-refreshing" data-testid="phone-list-refreshing">
                            <span className="phone-spinner" aria-hidden="true" /> Refreshing…
                        </div>
                    )}
                    <SessionList data={data} activeId={session?.id ?? null} onOpen={open} />
                </aside>
            )}
            {!wide && session && drawer && <div className="phone-scrim" onClick={() => setDrawer(false)} data-testid="phone-scrim" />}
            {session && (
                <main className="phone-main">
                    <SessionScreen
                        session={session}
                        lens={lens}
                        role={me.role}
                        showMenuButton={!wide}
                        menuBadge={badge}
                        offline={offline}
                        refreshing={refreshing}
                        chatPreferences={chatPreferences}
                        onSessionLink={openSessionLink}
                        onMenu={() => setDrawer(true)}
                        onLens={(next) => {
                            rememberLens(session.id, next)
                            navigate(session.id, next, true)
                        }}
                    />
                </main>
            )}
            {wide && !session && <main className="phone-main phone-empty">Pick a session.</main>}
            <HandoffNoticeToast />
            <PhoneFeedback me={me} sessionId={session?.id ?? null} lens={session ? (session.agent ? lens : 'terminal') : null} />
            {droplet && (
                <DropletPill
                    droplet={droplet}
                    onClose={closeDroplet}
                    onOpen={() => {
                        const target = data?.sessions.find((s) => s.id === droplet.sessionId)
                        setDroplet(null)
                        if (target) {
                            setDrawer(false)
                            navigate(target.id, target.agent ? 'chat' : 'terminal')
                        }
                    }}
                />
            )}
        </div>
    )
}
