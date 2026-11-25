import { Eye, Flag, Hammer, MessageCircle, type LucideIcon } from 'lucide-react'
import type { SessionWorkRole } from '../../../../shared/sessionLabels'

/**
 * One icon per session role (decision 0015). The sidebar row draws it in the icon slot, so a role
 * costs no width — the reviewer found text pills made a narrow sidebar narrower (2026-11-25).
 */
export const SESSION_ROLE_ICONS: Record<SessionWorkRole, LucideIcon> = {
    lead: Flag,
    work: Hammer,
    talk: MessageCircle,
    watch: Eye
}

export const SESSION_ROLE_COLORS: Record<SessionWorkRole, string> = {
    lead: 'text-rose-400',
    work: 'text-blue-400',
    talk: 'text-amber-400',
    watch: 'text-teal-400'
}

export function SessionRoleIcon({ role, size = 14 }: { role: SessionWorkRole; size?: number }) {
    const Icon = SESSION_ROLE_ICONS[role]
    return <Icon size={size} className={`shrink-0 ${SESSION_ROLE_COLORS[role]}`} />
}
