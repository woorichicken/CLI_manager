import { Bell, Eye, KeyRound, LucideIcon, MessageCircleQuestion } from 'lucide-react'
import { InboxKind } from '../../../../shared/types'

export const INBOX_KIND_META: Record<InboxKind, { icon: LucideIcon; color: string; label: string }> = {
    login: { icon: KeyRound, color: 'text-orange-400', label: 'Sign in' },
    review: { icon: Eye, color: 'text-blue-400', label: 'Review' },
    question: { icon: MessageCircleQuestion, color: 'text-purple-400', label: 'Question' },
    other: { icon: Bell, color: 'text-gray-400', label: 'Request' }
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** "just now", "5m", "3h", "2d" — the list row has room for a few characters only. */
export function formatInboxAge(at: number, now = Date.now()): string {
    const age = Math.max(0, now - at)
    if (age < MINUTE_MS) return 'just now'
    if (age < HOUR_MS) return `${Math.floor(age / MINUTE_MS)}m`
    if (age < DAY_MS) return `${Math.floor(age / HOUR_MS)}h`
    return `${Math.floor(age / DAY_MS)}d`
}

/**
 * Host and path of a web link, short enough for the row; the full address is in the tooltip.
 * Other schemes keep the scheme (`obsidian://open`), or the row would read as a bare word.
 */
export function shortLink(url: string): string {
    try {
        const parsed = new URL(url)
        const web = parsed.protocol === 'http:' || parsed.protocol === 'https:'
        const where = web ? parsed.host : `${parsed.protocol}//${parsed.host}`
        const shown = `${where}${parsed.pathname === '/' ? '' : parsed.pathname}`
        return shown.length > 48 ? `${shown.slice(0, 47)}…` : shown
    } catch {
        return url.length > 48 ? `${url.slice(0, 47)}…` : url
    }
}

/** What the badge shows: the exact count up to 99. */
export function badgeText(unread: number): string {
    return unread > 99 ? '99+' : String(unread)
}
