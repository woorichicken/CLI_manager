import type { SystemInfo } from '../shared/types'

/**
 * Pure parts of the System Monitor popover (header button), kept free of Electron and
 * child_process so tests can feed them real command output.
 */

/**
 * Where user files live on macOS 10.15+. `/` is the sealed, read-only system volume:
 * `df /` reports its own few GB (11%) while the disk is nearly full (fb-1117 9aebd089).
 */
export const MAC_DATA_VOLUME = '/System/Volumes/Data'

/** Finder and "About This Mac" count storage in decimal units; matching them is the point. */
const BYTES_PER_GB = 1000 ** 3
const KIB = 1024

/** `df -kP` with the data volume first when it exists; `/` alone everywhere else. */
export function diskCommand(hasDataVolume: boolean): string {
    return hasDataVolume ? `df -kP ${MAC_DATA_VOLUME} /` : 'df -kP /'
}

/** "994 GB", "1.2 TB", "8.4 GB" — what Finder would print. */
export function formatStorage(bytes: number): string {
    const gb = bytes / BYTES_PER_GB
    if (gb >= 1000) return `${(gb / 1000).toFixed(1)} TB`
    if (gb >= 10) return `${Math.round(gb)} GB`
    return `${gb.toFixed(1)} GB`
}

/**
 * Read `df -kP <mounts>` output (POSIX format, 1024-byte blocks) and describe the disk the
 * way Finder does: used = size − available, so used + free adds up to the size.
 *
 * APFS volumes share one container, so the data volume's own "Used" leaves out the system
 * volume, snapshots and VM files; size − available counts everything that is taken.
 * Prefers the data volume's line, falls back to `/`, then to the first line.
 * Returns null when nothing parses.
 */
export function parseDiskUsage(dfOutput: string): SystemInfo['disk'] | null {
    const rows = dfOutput
        .split('\n')
        .slice(1)
        .map((line) => line.trim().split(/\s+/))
        // Filesystem, blocks, used, available, capacity, mounted on (a mount path may hold spaces)
        .filter((parts) => parts.length >= 6)
        .map((parts) => ({
            mount: parts.slice(5).join(' '),
            sizeKiB: Number(parts[1]),
            availableKiB: Number(parts[3])
        }))
        .filter((row) => Number.isFinite(row.sizeKiB) && Number.isFinite(row.availableKiB) && row.sizeKiB > 0)

    const row = rows.find((r) => r.mount === MAC_DATA_VOLUME)
        ?? rows.find((r) => r.mount === '/')
        ?? rows[0]
    if (!row) return null

    const available = Math.min(row.availableKiB, row.sizeKiB)
    const used = row.sizeKiB - available
    return {
        total: formatStorage(row.sizeKiB * KIB),
        used: formatStorage(used * KIB),
        available: formatStorage(available * KIB),
        usagePercent: `${Math.round((used / row.sizeKiB) * 100)}%`
    }
}

export interface SessionActivityReader {
    ids(): string[]
    hasExited(id: string): boolean
    screenStatus(id: string): { busy: boolean; question: string | null }
}

export interface SessionActivityHook {
    status?: string
    source?: string
    awaitingInput?: boolean
}

/**
 * How many sessions are working on a turn or waiting for the person right now, read once
 * when the popover opens (no polling). Same rule as the sidebar status dots
 * (SessionScreenStatusPoller.judge): a question — on screen or from a hook — is waiting,
 * otherwise a busy screen or a running hook is working.
 */
export function countSessionActivity(
    mirror: SessionActivityReader,
    hookStatus: (id: string) => SessionActivityHook | null
): { working: number; waiting: number } {
    let working = 0
    let waiting = 0
    for (const id of mirror.ids()) {
        if (mirror.hasExited(id)) continue
        const screen = mirror.screenStatus(id)
        const hook = hookStatus(id)
        if (screen.question !== null || hook?.awaitingInput === true) {
            waiting += 1
        } else if (screen.busy || (hook?.source === 'hook' && hook.status === 'running')) {
            working += 1
        }
    }
    return { working, waiting }
}
