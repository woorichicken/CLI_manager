import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithSessions, closeApp, activateSession, resizeMainWindow, termState, LaunchResult } from './helpers'

/**
 * T41 — a terminal that starts hidden gets its real size, and its view never runs at a size the pty does not have
 * (reports f77530f2, 982d348d).
 *
 * Every session except the visible one mounts hidden: all restored sessions at startup, every session the
 * Control API opens in the background. Their pty used to start at a fixed 80x30, so a resumed Claude drew the
 * whole conversation 80 columns wide, and the first look at the session resized it. On a resize Claude Code
 * redraws only the rows on screen — the 80-column copy stays in the scrollback above the redrawn screen, and the
 * seam between the two drops or repeats rows. Both reports show an 80-column copy (widest line exactly 80) above
 * the full-width table.
 *
 * The view of a hidden session also used to drift from its pty (xterm's default 80x24 against a 80x30 pty, then
 * every window resize), so the renderer laid Claude's output out differently from the mirror in main.
 * And the first container change after startup was taken as the observer's baseline and dropped, leaving a
 * visible terminal with more rows than its box.
 *
 * Judged by what the program itself sees — its tty size at start and on every SIGWINCH, written to a file —
 * and by the terminal's rows against the height of its box.
 */

const VISIBLE = 'sess-t41-visible'
const HIDDEN = 'sess-t41-hidden'

/**
 * Command that records the tty size at start and on every SIGWINCH. It has to be the foreground
 * program itself: SIGWINCH goes to the foreground process group, so a shell `trap` misses every
 * resize that lands while its loop runs `sleep`.
 */
function sizeRecorder(dir: string, file: string): string {
    const script = path.join(dir, 'record-size.js')
    fs.writeFileSync(script, [
        "const fs = require('fs')",
        'const log = () => fs.appendFileSync(process.argv[2], `${process.stdout.rows} ${process.stdout.columns}\\n`)',
        'log()',
        "process.stdout.on('resize', log)",
        'setInterval(() => {}, 1 << 30)'
    ].join('\n'))
    return `'${process.execPath}' '${script}' '${file}'`
}

function readSizes(file: string): Array<{ rows: number; cols: number }> {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => {
        const [rows, cols] = line.trim().split(/\s+/).map(Number)
        return { rows, cols }
    })
}

async function viewSize(page: Page, id: string): Promise<{ rows: number; cols: number }> {
    const state = await termState(page, id)
    return { rows: state!.rows, cols: state!.cols }
}

test.describe('T41 hidden terminal size', () => {
    let ctx: LaunchResult
    let dir: string

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 't41-'))
    })

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test('a session that starts hidden starts at the size it will be shown at, so showing it resizes nothing', async () => {
        const file = path.join(dir, 'hidden-size.txt')
        ctx = await launchAppWithSessions([
            { id: VISIBLE, name: 'T41VISIBLE' },
            { id: HIDDEN, name: 'T41HIDDEN', initialCommand: sizeRecorder(dir, file) }
        ])
        const { page } = ctx
        await activateSession(page, 'T41VISIBLE')
        await page.waitForTimeout(1000)

        await expect.poll(() => readSizes(file).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
        const shown = await viewSize(page, VISIBLE)
        const [first] = readSizes(file)
        expect(first, `hidden pty started at ${first.cols}x${first.rows}, the visible terminal is ${shown.cols}x${shown.rows}`)
            .toEqual(shown)

        // First look at the hidden session: nothing to resize, so no SIGWINCH and no redraw.
        await activateSession(page, 'T41HIDDEN')
        await page.waitForTimeout(1500)
        expect(readSizes(file), 'showing the session must not resize its pty').toEqual([first])
        expect(await viewSize(page, HIDDEN)).toEqual(first)
    })

    test('while hidden, the view keeps the size of its pty and both change together when shown', async () => {
        const file = path.join(dir, 'hidden-size.txt')
        ctx = await launchAppWithSessions([
            { id: VISIBLE, name: 'T41VISIBLE' },
            { id: HIDDEN, name: 'T41HIDDEN', initialCommand: sizeRecorder(dir, file) }
        ])
        const { page, app } = ctx
        await activateSession(page, 'T41VISIBLE')
        await expect.poll(() => readSizes(file).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)

        // The window changes while the session is hidden: its pty is held back (no SIGWINCH storm)…
        await resizeMainWindow(app, 1000, 650)
        await page.waitForTimeout(1500)
        const ptyWhileHidden = readSizes(file).at(-1)!
        expect(readSizes(file), 'a hidden session gets no SIGWINCH').toHaveLength(1)
        // …and so is its view: output written now lands in a terminal of the size the program draws for.
        expect(await viewSize(page, HIDDEN), 'hidden view must match its pty').toEqual(ptyWhileHidden)

        // Shown: one resize, view and pty agree on the new size.
        await activateSession(page, 'T41HIDDEN')
        await page.waitForTimeout(1500)
        const sizes = readSizes(file)
        const view = await viewSize(page, HIDDEN)
        expect(sizes).toHaveLength(2)
        expect(sizes[1]).toEqual(view)
        expect(view).toEqual(await viewSize(page, VISIBLE))
    })

    test('the first window resize after startup reaches the visible terminal', async () => {
        ctx = await launchAppWithSessions([{ id: VISIBLE, name: 'T41VISIBLE' }])
        const { page, app } = ctx
        await activateSession(page, 'T41VISIBLE')
        await page.waitForTimeout(1000)
        const before = await viewSize(page, VISIBLE)

        // The observer's first call lands before the terminal is initialized; the first real change
        // after that used to be taken as the baseline and dropped — the terminal kept 43 rows in a
        // box that now held 34, so its bottom rows sat below the edge.
        await resizeMainWindow(app, 1000, 650)
        await page.waitForTimeout(1500)

        const after = await viewSize(page, VISIBLE)
        const fit = await page.evaluate((id) => {
            const screen = document.querySelector(`[data-session-id="${id}"] .xterm-screen`) as HTMLElement
            const box = screen.closest('.xterm')!.parentElement as HTMLElement
            return { screenHeight: screen.clientHeight, boxHeight: box.clientHeight }
        }, VISIBLE)
        const expectedRows = Math.floor(fit.boxHeight / (fit.screenHeight / after.rows))
        expect(after, 'the terminal must follow its box').not.toEqual(before)
        expect(Math.abs(after.rows - expectedRows), `${after.rows} rows in a box that fits ${expectedRows}`).toBeLessThanOrEqual(1)
    })
})
