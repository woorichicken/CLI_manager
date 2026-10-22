import { test, expect, Page } from '@playwright/test'
import { launchAppWithSessions, closeApp, writeToTerminal, resizeMainWindow, termState, LaunchResult } from './helpers'

/**
 * T38 — a window resize that lands while output is streaming must still be applied (report f77530f2).
 *
 * term.onScroll fires for every line a streaming TUI pushes, so the "user is scrolling" guard in
 * TerminalView stays on for as long as the output does. A size change that arrives in that window
 * used to be dropped for good: the terminal kept the old row count while its box got taller or
 * shorter, so the bottom rows were clipped (or a band stayed empty). v1.16.0 (a6166f8e) remembers
 * the skipped resize and applies it once the scrolling stops.
 *
 * Judged on geometry, not on counters: rows the terminal has × the height of one row must fill the
 * box it lives in to within one row.
 */

const SESSION = 'sess-t38'

async function geometry(page: Page): Promise<{ rows: number; cellHeight: number; boxHeight: number; expectedRows: number }> {
    const state = await termState(page, SESSION)
    const measured = await page.evaluate((id) => {
        const screen = document.querySelector(`[data-session-id="${id}"] .xterm-screen`) as HTMLElement
        const box = screen.closest('.xterm')!.parentElement as HTMLElement
        return { screenHeight: screen.clientHeight, boxHeight: box.clientHeight }
    }, SESSION)
    const rows = state!.rows
    const cellHeight = measured.screenHeight / rows
    return { rows, cellHeight, boxHeight: measured.boxHeight, expectedRows: Math.floor(measured.boxHeight / cellHeight) }
}

test.describe('T38 resize during streaming output', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('a resize that lands mid-stream is applied once the output stops', async () => {
        ctx = await launchAppWithSessions([{ id: SESSION, name: 'T38SESS' }])
        const { page, app } = ctx
        await page.getByText('T38SESS', { exact: true }).first().click()
        await page.waitForTimeout(1500)

        // ~100 lines/s: every line scrolls the buffer, so the scrolling guard never releases.
        await writeToTerminal(page, SESSION, 'for i in $(seq 1 400); do echo "stream line $i"; sleep 0.01; done\n')
        await page.waitForTimeout(800)

        // A real taller window: the box gains rows that the terminal must pick up.
        await resizeMainWindow(app, 1500, 1000)
        await page.waitForTimeout(500)

        // Output ends (~4s of stream), then give the 200ms scroll timer and the debounce time to run.
        await expect.poll(async () => (await termState(page, SESSION))?.length ?? 0, { timeout: 30_000 }).toBeGreaterThan(400)
        await page.waitForTimeout(2500)

        const g = await geometry(page)
        expect(
            Math.abs(g.rows - g.expectedRows),
            `terminal has ${g.rows} rows but its ${g.boxHeight}px box fits ${g.expectedRows}`
        ).toBeLessThanOrEqual(1)
    })
})
