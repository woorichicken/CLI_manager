/**
 * How a checklist's deadline reads in the header chip and panel. A deadline is a local
 * calendar date (YYYY-MM-DD, `Checklist.due`), compared with today's local date.
 */

export type DueTone = 'overdue' | 'today' | 'soon' | 'later'

/** Within this many days a deadline shows its weekday ("Fri") instead of the date. */
const WEEKDAY_WINDOW_DAYS = 6
const MS_PER_DAY = 24 * 60 * 60 * 1000

/** Today's local date as YYYY-MM-DD — what `due` is compared with. */
export function localDateKey(date = new Date()): string {
    const pad = (n: number): string => String(n).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function partsOf(key: string): [number, number, number] {
    const [y, m, d] = key.split('-').map(Number)
    return [y, m, d]
}

/** Whole days from one YYYY-MM-DD to another (negative when `to` is earlier). UTC so DST cannot shift it. */
export function daysBetween(fromKey: string, toKey: string): number {
    const [fy, fm, fd] = partsOf(fromKey)
    const [ty, tm, td] = partsOf(toKey)
    return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / MS_PER_DAY)
}

/** "3d overdue", "Today", "Tomorrow", "Fri", "Nov 12", "Jan 5, 2027" — with the colour it gets. */
export function describeDue(due: string, todayKey = localDateKey()): { label: string; tone: DueTone } {
    const days = daysBetween(todayKey, due)
    if (days < 0) return { label: `${-days}d overdue`, tone: 'overdue' }
    if (days === 0) return { label: 'Today', tone: 'today' }
    if (days === 1) return { label: 'Tomorrow', tone: 'soon' }
    const [y, m, d] = partsOf(due)
    const date = new Date(y, m - 1, d)
    if (days <= WEEKDAY_WINDOW_DAYS) return { label: date.toLocaleDateString('en-US', { weekday: 'short' }), tone: 'soon' }
    const sameYear = y === partsOf(todayKey)[0]
    const label = date.toLocaleDateString('en-US', sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
    return { label, tone: 'later' }
}

export const DUE_TONE_CLASSES: Record<DueTone, string> = {
    overdue: 'text-red-300 bg-red-500/15 border-red-500/30',
    today: 'text-amber-200 bg-amber-500/15 border-amber-500/30',
    soon: 'text-sky-200 bg-sky-500/10 border-sky-500/25',
    later: 'text-gray-300 bg-white/5 border-white/10',
}
