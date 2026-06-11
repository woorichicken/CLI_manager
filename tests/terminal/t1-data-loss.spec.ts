import { test, expect } from '@playwright/test'
import {
    launchAppWithSessions,
    closeApp,
    activateSession,
    writeToTerminal,
    waitForBufferText,
    termText,
    analyzeSeqContinuity,
    saveMetrics,
    LaunchResult
} from './helpers'

/**
 * T1 — Data loss under heavy output (flow control).
 *
 * Floods terminals with `seq` output. Lines are consecutive integers, so any
 * gap inside the retained scrollback window = data silently lost in the
 * pty → IPC → xterm.write pipeline (e.g. xterm's 50MB write-buffer discard).
 */

test.describe('T1 data loss', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('single visible terminal keeps seq output contiguous', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t1-solo', name: 'TSESS1' }])
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500) // let shell prompt settle

        await writeToTerminal(page, 'sess-t1-solo', 'seq 1 300000; echo SEQ-DONE-solo\n')
        await waitForBufferText(page, 'sess-t1-solo', 'SEQ-DONE-solo', 180_000)
        await page.waitForTimeout(1000)

        const text = await termText(page, 'sess-t1-solo')
        const result = analyzeSeqContinuity(text)
        const discards = ctx.pageErrors.filter(e => e.includes('discarded')).length

        saveMetrics('t1-solo', {
            retained: result.count,
            first: result.first,
            last: result.last,
            gapCount: result.gaps.length,
            gapsSample: result.gaps.slice(0, 5),
            discardErrors: discards
        })

        expect(result.last).toBe(300000)
        expect(result.gaps).toEqual([])
        expect(discards).toBe(0)
    })

    test('6 terminals flooding in parallel lose no data', async () => {
        const sessions = Array.from({ length: 6 }, (_, i) => ({
            id: `sess-t1-${i + 1}`,
            name: `TSESS${i + 1}`
        }))
        ctx = await launchAppWithSessions(sessions)
        const { page } = ctx

        await activateSession(page, 'TSESS1')
        await page.waitForTimeout(1500)

        for (const s of sessions) {
            await writeToTerminal(page, s.id, `seq 1 300000; echo SEQ-DONE-${s.id}\n`)
            await page.waitForTimeout(100)
        }

        for (const s of sessions) {
            await waitForBufferText(page, s.id, `SEQ-DONE-${s.id}`, 200_000)
        }
        await page.waitForTimeout(2000)

        const perTerminal: Record<string, { retained: number; last: number | null; gapCount: number }> = {}
        let totalGaps = 0
        for (const s of sessions) {
            const text = await termText(page, s.id)
            const result = analyzeSeqContinuity(text)
            perTerminal[s.id] = { retained: result.count, last: result.last, gapCount: result.gaps.length }
            totalGaps += result.gaps.length
        }
        const discards = ctx.pageErrors.filter(e => e.includes('discarded')).length

        saveMetrics('t1-parallel', { perTerminal, totalGaps, discardErrors: discards })

        for (const s of sessions) {
            expect(perTerminal[s.id].last, `${s.id} should reach 300000`).toBe(300000)
            expect(perTerminal[s.id].gapCount, `${s.id} should have no gaps`).toBe(0)
        }
        expect(discards).toBe(0)
    })
})
