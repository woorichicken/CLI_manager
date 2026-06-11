import { test, expect } from '@playwright/test'
import {
    launchAppWithSessions,
    closeApp,
    activateSession,
    writeToTerminal,
    waitForBufferText,
    termText,
    saveMetrics,
    LaunchResult
} from './helpers'

/**
 * T3 — History preservation across TUI repaints.
 *
 * The mock TUI emits numbered history lines and periodic full clears (CSI 2J),
 * like CLIs repainting on resize. Two checks:
 *  1. continuity: HIST-NNNNNN numbers retained in scrollback should be
 *     contiguous — missing ranges mean conversation history was destroyed
 *  2. frame residue: how many duplicate UI box frames pollute scrollback
 */

function analyzeHistContinuity(text: string): {
    count: number
    first: number | null
    last: number | null
    missing: number
    gapRanges: Array<[number, number]>
} {
    const nums: number[] = []
    const re = /HIST-(\d{6})/g
    const seen = new Set<number>()
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
        const n = Number(m[1])
        if (!seen.has(n)) {
            seen.add(n)
            nums.push(n)
        }
    }
    nums.sort((a, b) => a - b)
    const gapRanges: Array<[number, number]> = []
    let missing = 0
    for (let i = 1; i < nums.length; i++) {
        const gap = nums[i] - nums[i - 1] - 1
        if (gap > 0) {
            missing += gap
            gapRanges.push([nums[i - 1] + 1, nums[i] - 1])
        }
    }
    return { count: nums.length, first: nums[0] ?? null, last: nums[nums.length - 1] ?? null, missing, gapRanges }
}

test.describe('T3 history preservation', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('full-clear repaints do not destroy history lines', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t3', name: 'TSESS1' }])
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        // 12s run, 10fps, 20 hist/s, full clear every 30 frames (4 clears)
        await writeToTerminal(
            page,
            'sess-t3',
            'node scripts/mock-cli/claude-mock.cjs --duration 12 --fps 10 --hist 20 --clear-every 30\n'
        )
        await waitForBufferText(page, 'sess-t3', 'mock-claude done', 60_000)
        await page.waitForTimeout(1000)

        const text = await termText(page, 'sess-t3')
        const hist = analyzeHistContinuity(text)
        const frameResidue = (text.match(/╭─{10,}/g) || []).length

        saveMetrics('t3-history', {
            retained: hist.count,
            first: hist.first,
            last: hist.last,
            missing: hist.missing,
            gapRanges: hist.gapRanges.slice(0, 10),
            frameResidue
        })

        // History that scrolled into scrollback must survive full clears,
        // and nothing in the middle may vanish.
        expect(hist.first, 'first history line must survive').toBe(1)
        expect(hist.missing, 'no history lines may be destroyed by repaints').toBe(0)
    })

    test('real claude recording replays without losing response text', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t3r', name: 'TSESS1' }])
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        await writeToTerminal(
            page,
            'sess-t3r',
            'node scripts/mock-cli/replay.cjs scripts/mock-cli/recordings/claude.jsonl --speed 8 --max-delay 100\n'
        )
        await waitForBufferText(page, 'sess-t3r', 'REPLAY-COMPLETE', 90_000)
        await page.waitForTimeout(1000)

        const text = await termText(page, 'sess-t3r')
        // The recorded session contains a real model response line
        const hasResponse = text.includes('당근') || /1\.\s+\S+/.test(text)
        const hasBanner = text.includes('Claude Code v')

        saveMetrics('t3-replay', {
            bufferChars: text.length,
            hasResponse,
            hasBanner
        })

        expect(hasResponse, 'replayed model response must be present in buffer').toBe(true)
    })
})
