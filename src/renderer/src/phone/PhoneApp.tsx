import { useCallback, useEffect, useRef, useState } from 'react'
import { Laptop } from 'lucide-react'
import type { PhoneMe, PhoneSession, PhoneSessionsResponse } from '../../../shared/phone'
import { getMe, getSessions, PhoneApiError } from './api'
import { AlertsMenu } from './AlertsMenu'
import { DropletPill } from './DropletPill'
import { dropletFor, nextSeen, waitingElsewhere, type Droplet, type SeenState } from './droplets'
import { PairScreen } from './PairScreen'
import { SessionList } from './SessionList'
import { SessionScreen, type SessionLens } from './SessionScreen'

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

export function PhoneApp() {
    const [me, setMe] = useState<PhoneMe | null>(null)
    const [data, setData] = useState<PhoneSessionsResponse | null>(null)
    const [route, setRoute] = useState(readRoute)
    const [drawer, setDrawer] = useState(false)
    const [offline, setOffline] = useState(false)
    const wide = useWide()
    const edge = useRef<{ x: number; y: number } | null>(null)
    const [droplet, setDroplet] = useState<Droplet | null>(null)
    const seen = useRef<Map<string, SeenState> | null>(null)
    const openIdRef = useRef<string | null>(route.sessionId)
    openIdRef.current = route.sessionId

    const loadMe = useCallback(() => {
        getMe().then(setMe).catch(() => setOffline(true))
    }, [])
    useEffect(loadMe, [loadMe])

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
                        if (news) setDroplet(news)
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

    if (offline && !me) return <div className="phone-empty phone-fill">The Mac is not answering. Is CLI Manager running, with Settings › Phone on?</div>
    if (!me) return <div className="phone-empty phone-fill">Connecting to the Mac…</div>
    if (me.access === 'none') return <PairScreen reason={me.reason} onPaired={loadMe} />

    const session = data?.sessions.find((s) => s.id === route.sessionId) ?? null
    const lens: SessionLens = route.view ?? (session ? rememberedLens(session.id) : null) ?? 'chat'
    const open = (next: PhoneSession): void => {
        setDrawer(false)
        navigate(next.id, next.agent ? rememberedLens(next.id) ?? 'chat' : 'terminal')
    }
    const showList = wide || !session || drawer
    const badge = data ? waitingElsewhere(data.sessions, session?.id ?? null) : 0

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
                        <AlertsMenu publicKey={me.push.publicKey} />
                    </div>
                    {offline && <div className="phone-offline">Reconnecting to the Mac…</div>}
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
                        onMenu={() => setDrawer(true)}
                        onLens={(next) => {
                            rememberLens(session.id, next)
                            navigate(session.id, next, true)
                        }}
                    />
                </main>
            )}
            {wide && !session && <main className="phone-main phone-empty">Pick a session.</main>}
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
