/**
 * Shared time formatting helpers for the Loop Dashboard (list + stats modal).
 */

/** "just now" / "13s ago" / "2m ago" / "1h ago" / "3d ago" (— when null). */
export function formatRelativeTime(ts: number | null | undefined): string {
    if (ts === null || ts === undefined) return '—'
    const diffSec = Math.floor((Date.now() - ts) / 1000)
    if (diffSec < 10) return 'just now'
    if (diffSec < 60) return `${diffSec}s ago`
    const min = Math.floor(diffSec / 60)
    if (min < 60) return `${min}m ago`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ago`
    return `${Math.floor(hr / 24)}d ago`
}

/** Absolute wall-clock time, e.g. "14:10:21". */
export function formatClock(ts: number): string {
    const d = new Date(ts)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Compact duration, e.g. "45s" / "3m 12s" / "2h 5m" / "1d 4h". */
export function formatDuration(ms: number): string {
    const clamped = Math.max(0, ms)
    const sec = Math.floor(clamped / 1000)
    if (sec < 60) return `${sec}s`
    const min = Math.floor(sec / 60)
    if (min < 60) return `${min}m ${sec % 60}s`
    const hr = Math.floor(min / 60)
    if (hr < 24) return `${hr}h ${min % 60}m`
    const day = Math.floor(hr / 24)
    return `${day}d ${hr % 24}h`
}

/** Min / max / average interval (ms) between successive iteration timestamps. */
export function intervalStats(
    recent: Array<{ index: number; at: number }> | undefined,
): { avg: number | null; min: number | null; max: number | null } {
    if (!recent || recent.length < 2) return { avg: null, min: null, max: null }
    const diffs: number[] = []
    for (let i = 1; i < recent.length; i++) {
        diffs.push(recent[i].at - recent[i - 1].at)
    }
    const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length
    return { avg, min: Math.min(...diffs), max: Math.max(...diffs) }
}
