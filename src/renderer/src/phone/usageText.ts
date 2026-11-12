/** Words for the usage view (PhoneUsagePanel) — apart from the component so the tests read it without the CSS. */

/** «in 3h 12m», «in 2d 4h» — until a window resets */
export function untilReset(iso: string | null, now = Date.now()): string | null {
    if (!iso) return null
    const ms = Date.parse(iso) - now
    if (!Number.isFinite(ms)) return null
    if (ms <= 0) return 'resetting'
    const minutes = Math.round(ms / 60_000)
    const days = Math.floor(minutes / 1440)
    const hours = Math.floor((minutes % 1440) / 60)
    const rest = minutes % 60
    if (days > 0) return `in ${days}d ${hours}h`
    if (hours > 0) return `in ${hours}h ${rest}m`
    return `in ${rest}m`
}
