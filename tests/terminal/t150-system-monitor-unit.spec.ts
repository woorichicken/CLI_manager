import { test, expect } from '@playwright/test'
import {
    countSessionActivity,
    diskCommand,
    formatStorage,
    MAC_DATA_VOLUME,
    parseDiskUsage
} from '../../src/main/systemMonitorInfo'

/**
 * T150 — System Monitor popover, without Electron (fb-1117 9aebd089 · 67732aa2).
 *
 * Disk: real `df -kP` output from a Mac on 2026-11-17. `/` is the sealed system volume (11% used)
 * while the disk is 90% full; the popover read `/` and said 11Gi of 926Gi. The data volume's line
 * must win, and the numbers must read like Finder's (decimal GB, used + free = size).
 *
 * Sessions: "running now" counts use the sidebar dots' rule on one read of each screen.
 *
 * Fails on the code before this change: the module does not exist.
 */

// `df -kP /System/Volumes/Data /` — a 1 TB MacBook, 2026-11-17
const DF_MAC = [
    'Filesystem     1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s5     971298980 816734464 100178252    90%    /System/Volumes/Data',
    '/dev/disk3s1s1   971298980  11982364 100178252    11%    /',
    ''
].join('\n')

// `df -kP /` — the same Mac, the line the old popover read
const DF_ROOT_ONLY = [
    'Filesystem     1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1   971298980  11982364 100147468    11%    /',
    ''
].join('\n')

const KIB = 1024
const GB = 1e9

test.describe('T150 system monitor — disk', () => {
    test('the data volume wins over the sealed system volume, in Finder units', () => {
        const disk = parseDiskUsage(DF_MAC)
        const size = 971298980 * KIB
        const free = 100178252 * KIB
        expect(disk).toEqual({
            total: `${Math.round(size / GB)} GB`,
            used: `${Math.round((size - free) / GB)} GB`,
            available: `${Math.round(free / GB)} GB`,
            usagePercent: `${Math.round(((size - free) / size) * 100)}%`
        })
        // Not the system volume's 11%.
        expect(disk?.usagePercent).not.toBe('11%')
        expect(disk?.total).not.toMatch(/Gi/)
    })

    test('with no data volume line, / is read the same way (size − free, not its own Used)', () => {
        const disk = parseDiskUsage(DF_ROOT_ONLY)
        const size = 971298980 * KIB
        const free = 100147468 * KIB
        expect(disk?.usagePercent).toBe(`${Math.round(((size - free) / size) * 100)}%`)
        expect(disk?.used).toBe(`${Math.round((size - free) / GB)} GB`)
    })

    test('the command asks for the data volume only when it exists', () => {
        expect(diskCommand(true)).toBe(`df -kP ${MAC_DATA_VOLUME} /`)
        expect(diskCommand(false)).toBe('df -kP /')
    })

    test('a mount path with spaces, and garbage, are handled', () => {
        const spaced = [
            'Filesystem 1024-blocks Used Available Capacity Mounted on',
            '/dev/disk9s1 1000000 400000 600000 40% /Volumes/My Disk',
            ''
        ].join('\n')
        expect(parseDiskUsage(spaced)?.usagePercent).toBe('40%')
        expect(parseDiskUsage('')).toBeNull()
        expect(parseDiskUsage('Filesystem 1024-blocks Used Available Capacity Mounted on\nnot a line')).toBeNull()
    })

    test('sizes print like Finder', () => {
        expect(formatStorage(994.6 * GB)).toBe('995 GB')
        expect(formatStorage(8.44 * GB)).toBe('8.4 GB')
        expect(formatStorage(2_000.4 * GB)).toBe('2.0 TB')
    })
})

test.describe('T150 system monitor — sessions running now', () => {
    const screens: Record<string, { busy: boolean; question: string | null; exited?: boolean }> = {
        work: { busy: true, question: null },
        ask: { busy: false, question: 'Do you want to proceed?' },
        idle: { busy: false, question: null },
        gone: { busy: true, question: null, exited: true },
        hooked: { busy: false, question: null },
        nudged: { busy: false, question: null }
    }
    const mirror = {
        ids: () => Object.keys(screens),
        hasExited: (id: string) => screens[id].exited === true,
        screenStatus: (id: string) => ({ busy: screens[id].busy, question: screens[id].question })
    }

    test('working = busy screen or running hook; waiting = question on screen or from a hook; exited is neither', () => {
        const hooks: Record<string, { status: string; source: string; awaitingInput?: boolean }> = {
            hooked: { status: 'running', source: 'hook' },
            nudged: { status: 'ready', source: 'hook', awaitingInput: true }
        }
        expect(countSessionActivity(mirror, (id) => hooks[id] ?? null)).toEqual({ working: 2, waiting: 2 })
    })

    test('a heuristic "running" is not a hook, and with no hooks only the screen counts', () => {
        expect(countSessionActivity(mirror, (id) => (id === 'hooked' ? { status: 'running', source: 'heuristic' } : null)))
            .toEqual({ working: 1, waiting: 1 })
    })
})
