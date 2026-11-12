import { BlockList, isIP } from 'net'
import type { PhoneRefusal, PhoneRole, PhoneVia } from '../../shared/phone'

/**
 * Who a phone request is, and whether it gets in. Pure functions — no server, no
 * store — so the rules can be tested as a table (tests/terminal/t75-phone-unit.spec.ts).
 *
 * The phone server listens on 127.0.0.1 only. A phone reaches it through
 * `tailscale serve`, which the person runs themselves (the app shows the command,
 * never runs it). Serve proxies from this Mac, so every request arrives from
 * loopback; what tells them apart is what serve writes on the way in:
 *   - `Tailscale-User-Login`: the requesting device's Tailscale login. Serve strips
 *     any copy the device sent, so it is trusted only from loopback, with an
 *     `X-Forwarded-For` serve wrote (a tailnet address).
 *   - `Tailscale-Funnel-Request`: the request came from the public internet
 *     through Funnel — refused whatever else it carries.
 * A login equal to this Mac's own Tailscale login (`tailscale status --json`) is
 * the owner and gets in. Anything else needs a paired-device cookie: a six-digit
 * code shown in Settings › Phone, ten minutes, five tries (PhoneDevices).
 *
 * The rules follow ovis `server/access.ts` (MIT, devswha) — loopback + login +
 * tailnet XFF for the owner, pairing for the rest — rewritten for this app: no
 * shared token, no open mode, no relay. A request with no login is never the owner.
 */

export interface PhoneAccessInput {
    /** Settings › Phone is on */
    enabled: boolean
    /** the TCP peer is 127/8 or ::1 */
    loopback: boolean
    /** `Tailscale-Funnel-Request` is present */
    funnel: boolean
    /** `Tailscale-User-Login`, as sent */
    tailscaleLogin: string | null
    /** `X-Forwarded-For`, as sent — serve replaces it with the device's tailnet address */
    forwardedFor: string | null
    /** this Mac's own Tailscale login, when `tailscale status` names one */
    owner: string | null
    /** the paired device this request's cookie belongs to */
    device: { id: string; label: string; role: PhoneRole } | null
}

export type PhoneAccess =
    | { level: 'full'; role: PhoneRole; via: PhoneVia; login?: string; deviceId?: string; deviceLabel?: string }
    | { level: 'none'; reason: PhoneRefusal }

// Tailscale assigns these (net/tsaddr): CGNAT 100.64/10 and the ULA fd7a:115c:a1e0::/48.
const TAILNET_V4 = new BlockList()
TAILNET_V4.addSubnet('100.64.0.0', 10, 'ipv4')
const TAILNET_V6 = new BlockList()
TAILNET_V6.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6')

export function isLoopbackAddress(address: string | undefined | null): boolean {
    if (!address) return false
    return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Is this one address (not a list) a Tailscale address? */
export function isTailnetAddress(address: string | null | undefined): boolean {
    const value = (address ?? '').trim()
    const family = isIP(value)
    if (family === 4) return TAILNET_V4.check(value, 'ipv4')
    if (family === 6) return TAILNET_V6.check(value, 'ipv6')
    return false
}

export function decidePhoneAccess(input: PhoneAccessInput): PhoneAccess {
    if (!input.enabled) return { level: 'none', reason: 'disabled' }
    // the public internet is never let in, paired cookie or not
    if (input.funnel) return { level: 'none', reason: 'funnel' }
    if (!input.loopback) return { level: 'none', reason: 'not_local' }
    if (input.device) {
        return { level: 'full', role: input.device.role, via: 'device', deviceId: input.device.id, deviceLabel: input.device.label }
    }
    const login = input.tailscaleLogin?.trim() || null
    // Serve writes one tailnet address here. Anything else (a list, a LAN address, none) is
    // not serve's request, whatever login it names.
    if (login && input.owner && isTailnetAddress(input.forwardedFor) && login.toLowerCase() === input.owner.toLowerCase()) {
        return { level: 'full', role: 'drive', via: 'tailscale', login }
    }
    return { level: 'none', reason: 'pairing_required' }
}

/**
 * The name a Host header addresses — lower case, no port, no root dot — read as a bare
 * authority so `evil.example@localhost` is not taken for localhost.
 */
export function hostName(host: string | null | undefined): string | null {
    const match = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+)(?::\d{1,5})?$/i.exec(host ?? '')
    return match ? match[1].toLowerCase().replace(/\.$/, '') : null
}

/**
 * The Host names this Mac: loopback (a browser on the Mac itself), its MagicDNS name
 * (`*.ts.net`, what serve passes through) or a tailnet address. Any other name is a page
 * whose DNS points at 127.0.0.1 (rebinding) — refused before anything else is read.
 */
export function hostAllowed(host: string | null | undefined): boolean {
    const name = hostName(host)
    if (name === null) return false
    if (name === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(name) || name === '[::1]') return true
    if (name.endsWith('.ts.net')) return true
    return isTailnetAddress(name.replace(/^\[|\]$/g, ''))
}

/**
 * A browser request that changes something must come from the page itself: its Origin
 * names the same host. A request without Origin (curl, the test runner) passes — it is
 * not a browser page riding the person's cookie.
 */
export function sameOrigin(origin: string | null | undefined, host: string | null | undefined): boolean {
    if (!origin) return true
    if (origin === 'null') return false
    try {
        return new URL(origin).host.toLowerCase() === (host ?? '').toLowerCase()
    } catch {
        return false
    }
}

/**
 * This Mac's own Tailscale login from `tailscale status --json`, or null when it names
 * none (logged out, or a tagged node — which belongs to no person, ovis tailscale.ts:135).
 */
export function parseTailscaleOwner(statusJson: string | null): string | null {
    if (!statusJson) return null
    try {
        // Every `UserID` kept as the digits written: Tailscale's user ids run past 2^53, where
        // JSON.parse rounds 15633668397603135 to …136 and the id then names no user (ovis
        // server/tailscale.ts:42-46, #526 — MIT).
        const status = JSON.parse(statusJson.replace(/("UserID"\s*:\s*)(\d+)/g, '$1"$2"')) as {
            BackendState?: string
            Self?: { UserID?: number | string | null; Tags?: string[]; DNSName?: string }
            User?: Record<string, { LoginName?: string }>
        }
        const self = status.Self
        if (!self || self.UserID === undefined || self.UserID === null) return null
        if ((self.Tags?.length ?? 0) > 0) return null
        return status.User?.[String(self.UserID)]?.LoginName || null
    } catch {
        return null
    }
}

/** This Mac's MagicDNS name (`mac.tailnet.ts.net`), for the address Settings shows. */
/**
 * Tailscale is installed and signed in but switched off (`BackendState: Stopped`, or NeedsLogin…):
 * no phone can reach this Mac, while the name and the login still read fine. A missing state is
 * not called stopped — an older CLI may not print it.
 */
export function parseTailscaleStopped(statusJson: string | null): boolean {
    if (!statusJson) return false
    try {
        const state = (JSON.parse(statusJson) as { BackendState?: unknown }).BackendState
        return typeof state === 'string' && state !== 'Running'
    } catch {
        return false
    }
}

export function parseTailscaleDnsName(statusJson: string | null): string | null {
    if (!statusJson) return null
    try {
        const name = (JSON.parse(statusJson) as { Self?: { DNSName?: string } }).Self?.DNSName
        return name ? name.replace(/\.$/, '') : null
    } catch {
        return null
    }
}
