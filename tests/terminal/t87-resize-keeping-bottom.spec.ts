import { test, expect, Page } from '@playwright/test'
import { join } from 'path'
import { launchAppWithSessions, closeApp, writeToTerminal, resizeMainWindow, termText, termState, LaunchResult, resetDebugCounters, debugCounters } from './helpers'

/**
 * T87 — a height change in the real app keeps every line of an inline TUI once (renderer and mirror).
 *
 * T86 checks resizeKeepingBottom on recorded bytes. This runs the real path: a window
 * resize → TerminalView fits the terminal (resizeKeepingBottom) → one pty resize →
 * SIGWINCH → the program repaints the screen from the top (fixtures/inline-tui.cjs does
 * what Claude Code does) → the mirror in main took the same resize. Old code: shrinking
 * dropped the box at the bottom and the repaint covered the top lines (some lines 0 times);
 * growing added blank rows and the repaint drew the tail a second time (some lines twice).
 *
 * Also: one window resize that changes rows and columns sends one pty resize, not two.
 */

const SESSION = 'sess-t87'
const LINES = 120
const MOCK = join(__dirname, 'fixtures', 'inline-tui.cjs')

/** How many times each "tui line N" appears, for the N that are not exactly once. */
function miscounted(text: string[]): Record<string, number> {
    const seen = new Map<number, number>()
    for (const line of text) {
        const match = /^tui line (\d+)$/.exec(line.trimEnd())
        if (match) seen.set(Number(match[1]), (seen.get(Number(match[1])) ?? 0) + 1)
    }
    const wrong: Record<string, number> = {}
    for (let n = 1; n <= LINES; n++) if ((seen.get(n) ?? 0) !== 1) wrong[`tui line ${n}`] = seen.get(n) ?? 0
    return wrong
}

async function mirrorLines(page: Page): Promise<string[]> {
    const context = await page.evaluate(
        (id) => (window as unknown as { api: { feedbackTerminalContext: (id: string) => Promise<{ terminal: { recentLines: string[] } | null }> } })
            .api.feedbackTerminalContext(id),
        SESSION
    )
    return context.terminal?.recentLines ?? []
}

async function windowSize(ctx: LaunchResult): Promise<[number, number]> {
    return ctx.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getSize() as [number, number])
}

test.describe('T87 bottom-anchored resize in the app', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('shrinking and growing the window keeps every line once, on screen and in the mirror', async () => {
        ctx = await launchAppWithSessions([{ id: SESSION, name: 'T87SESS' }])
        const { page, app } = ctx
        await page.getByText('T87SESS', { exact: true }).first().click()
        await page.waitForTimeout(1500)

        await writeToTerminal(page, SESSION, `clear; node ${JSON.stringify(MOCK)} ${LINES}\n`)
        await expect.poll(async () => (await termText(page, SESSION)).includes('footer: ready'), { timeout: 20_000 }).toBe(true)
        await page.waitForTimeout(500)

        const [width, height] = await windowSize(ctx)
        const startRows = (await termState(page, SESSION))!.rows
        const seenRows: number[] = []
        for (const h of [height - 200, height, height + 150]) {
            await resizeMainWindow(app, width, h)
            await page.waitForTimeout(1500)
            const state = await termState(page, SESSION)
            seenRows.push(state!.rows)
            const screen = (await termText(page, SESSION)).split('\n')
            expect({ rows: state!.rows, wrong: miscounted(screen) }, 'renderer').toEqual({ rows: state!.rows, wrong: {} })
            expect({ rows: state!.rows, wrong: miscounted(await mirrorLines(page)) }, 'mirror').toEqual({ rows: state!.rows, wrong: {} })
        }
        // The window really changed the row count both ways.
        expect(seenRows[0]).toBeLessThan(startRows)
        expect(seenRows[2]).toBeGreaterThan(startRows)
        await writeToTerminal(page, SESSION, '\x03')
    })

    test('one window resize that changes rows and columns sends one pty resize', async () => {
        ctx = await launchAppWithSessions([{ id: SESSION, name: 'T87SESS' }])
        const { page, app } = ctx
        await page.getByText('T87SESS', { exact: true }).first().click()
        await page.waitForTimeout(1500)
        // Past 200 lines the resize manager stops applying everything at once.
        await writeToTerminal(page, SESSION, 'seq 1 400\n')
        await expect.poll(async () => (await termState(page, SESSION))?.length ?? 0, { timeout: 20_000 }).toBeGreaterThan(400)
        await page.waitForTimeout(500)

        const [width, height] = await windowSize(ctx)
        const before = (await termState(page, SESSION))!
        await resetDebugCounters(page)
        await resizeMainWindow(app, width - 160, height - 120)
        await page.waitForTimeout(1500)
        const after = (await termState(page, SESSION))!
        expect(after.cols).toBeLessThan(before.cols)
        expect(after.rows).toBeLessThan(before.rows)
        expect((await debugCounters(page)).ptyResize[SESSION] ?? 0).toBe(1)

        // Rows alone: applied at once, still one.
        await resetDebugCounters(page)
        await resizeMainWindow(app, width - 160, height)
        await page.waitForTimeout(1500)
        expect((await termState(page, SESSION))!.cols).toBe(after.cols)
        expect((await debugCounters(page)).ptyResize[SESSION] ?? 0).toBe(1)
    })
})
