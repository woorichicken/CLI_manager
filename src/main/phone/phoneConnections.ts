import type { PhoneConnection, PhoneConnectionVisit } from '../../shared/types'

/**
 * Who has the phone page open now, for Settings › Phone and the sidebar badge (phone-fixes C-2).
 * A key is connected while it has a socket open, or made a request within `windowMs`. Kept apart
 * from PhoneServer so it is tested without a server; times are passed in.
 */
export class PhoneConnections {
    private readonly visits = new Map<string, PhoneConnectionVisit & { since: number; at: number }>()
    private readonly sockets = new Map<string, number>()

    constructor(private readonly windowMs: number) {}

    /** A request from `key`. True when it was not connected before (the list changed). */
    seen(key: string, visit: PhoneConnectionVisit, now = Date.now()): boolean {
        const before = this.isConnected(key, now)
        const previous = this.visits.get(key)
        this.visits.set(key, { ...visit, since: before && previous ? previous.since : now, at: now })
        return !before
    }

    opened(key: string): void {
        this.sockets.set(key, (this.sockets.get(key) ?? 0) + 1)
    }

    /** A socket closed: the window starts again from now. */
    closed(key: string, now = Date.now()): void {
        const left = (this.sockets.get(key) ?? 1) - 1
        if (left > 0) this.sockets.set(key, left)
        else this.sockets.delete(key)
        const visit = this.visits.get(key)
        if (visit) visit.at = now
    }

    /** Oldest first. Drops what fell out of the window. */
    list(now = Date.now()): PhoneConnection[] {
        const connected: PhoneConnection[] = []
        for (const [key, visit] of this.visits) {
            if (!this.isConnected(key, now)) {
                this.visits.delete(key)
                continue
            }
            const { since, at, ...rest } = visit
            connected.push({ key, ...rest, since: new Date(since).toISOString(), lastSeen: new Date(at).toISOString(), live: this.sockets.has(key) })
        }
        return connected.sort((a, b) => a.since.localeCompare(b.since))
    }

    count(now = Date.now()): number {
        return this.list(now).length
    }

    /** A revoked device is gone now, not a minute later. */
    forget(matches: (key: string) => boolean): void {
        for (const key of [...this.visits.keys()]) if (matches(key)) this.visits.delete(key)
    }

    clear(): void {
        this.visits.clear()
        this.sockets.clear()
    }

    private isConnected(key: string, now: number): boolean {
        if (this.sockets.has(key)) return true
        const visit = this.visits.get(key)
        return visit !== undefined && now - visit.at <= this.windowMs
    }
}

/**
 * A short name for the browser a phone uses, from its User-Agent: «Chrome · Android». Android Chrome
 * no longer sends the model (UA reduction), so the device itself is the paired name, not this.
 * Null when it says nothing recognisable.
 */
export function describeBrowser(userAgent: string | undefined | null): string | null {
    const ua = userAgent ?? ''
    const platform = /iPad/.test(ua) ? 'iPad'
        : /iPhone/.test(ua) ? 'iPhone'
        : /Android/.test(ua) ? 'Android'
        : /Macintosh|Mac OS X/.test(ua) ? 'Mac'
        : /Windows/.test(ua) ? 'Windows'
        : /Linux/.test(ua) ? 'Linux'
        : null
    const browser = /Electron\//.test(ua) ? 'Electron'
        : /SamsungBrowser\//.test(ua) ? 'Samsung Internet'
        : /Edg(?:A|iOS)?\//.test(ua) ? 'Edge'
        : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox'
        : /CriOS\/|Chrome\//.test(ua) ? 'Chrome'
        : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
        : null
    if (!browser) return null
    return platform ? `${browser} · ${platform}` : browser
}
