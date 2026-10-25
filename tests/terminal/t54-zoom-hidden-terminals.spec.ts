import { test, expect, Page, ElectronApplication } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithSessions, closeApp, activateSession, termState, LaunchResult } from './helpers'

/**
 * T54 — Cmd+- / Cmd+= re-fonts only the terminals on screen (report f800638c: "cmd + - 에서 오래 버퍼링").
 *
 * Every TerminalView got the new font on each press, hidden ones included. Setting xterm's font re-measures the
 * cell and re-renders every row, and `visibility: hidden` does not skip that work: measured with the installed
 * xterm 6.0, one press took 29ms with 1 terminal, 190ms with 10 and 925ms with 39 (the reporter's app), against
 * 28ms with 39 when only the visible one changes. A hidden terminal now takes the font when it is shown, right
 * before the fit that already runs then — so its pty still gets exactly one resize, at the new size.
 *
 * Judged by the font each view renders with (`__termDebug.fontSize`) and by what the hidden program itself
 * sees: its tty size at start and on every SIGWINCH, written to a file (same recorder as T41).
 */

const VISIBLE = 'sess-t54-visible'
const HIDDEN = 'sess-t54-hidden'
const OTHERS = ['sess-t54-other-1', 'sess-t54-other-2', 'sess-t54-other-3']

/** The foreground program records its own tty size — a shell `trap` misses SIGWINCH while `sleep` runs. */
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

async function fontSize(page: Page, id: string): Promise<number | null> {
    return page.evaluate(
        (sessionId) =>
            (window as unknown as { __termDebug: { fontSize: (id: string) => number | null } })
                .__termDebug.fontSize(sessionId),
        id
    )
}

/**
 * Cmd+- through the native input path, so main's `before-input-event` sees it like a real key press.
 * Playwright's `page.keyboard` goes in through CDP and never reaches that handler.
 */
async function pressZoomOut(app: ElectronApplication): Promise<void> {
    await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html'))
            ?? BrowserWindow.getAllWindows()[0]
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: '-', modifiers: ['meta'] })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: '-', modifiers: ['meta'] })
    })
}

async function viewSize(page: Page, id: string): Promise<{ rows: number; cols: number }> {
    const state = await termState(page, id)
    return { rows: state!.rows, cols: state!.cols }
}

test.describe('T54 zoom reaches only visible terminals', () => {
    let ctx: LaunchResult
    let dir: string

    test.beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 't54-'))
    })

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test('Cmd+- leaves hidden terminals alone; a hidden one takes the font when shown, with one pty resize', async () => {
        const file = path.join(dir, 'hidden-size.txt')
        ctx = await launchAppWithSessions([
            { id: VISIBLE, name: 'T54VISIBLE' },
            { id: HIDDEN, name: 'T54HIDDEN', initialCommand: sizeRecorder(dir, file) },
            ...OTHERS.map((id, i) => ({ id, name: `T54OTHER${i + 1}` }))
        ])
        const { page, app } = ctx
        await activateSession(page, 'T54VISIBLE')
        await expect.poll(() => readSizes(file).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1)
        await page.waitForTimeout(500)

        const startFont = (await fontSize(page, VISIBLE))!
        expect(startFont).toBeGreaterThan(9)
        for (const id of [HIDDEN, ...OTHERS]) expect(await fontSize(page, id)).toBe(startFont)
        const hiddenBefore = await viewSize(page, HIDDEN)

        // Three presses while the session is hidden: the real key path (main's before-input-event → IPC).
        for (let i = 0; i < 3; i++) {
            await pressZoomOut(app)
            await page.waitForTimeout(150)
        }
        const zoomed = startFont - 3
        await expect.poll(() => fontSize(page, VISIBLE), { timeout: 5_000 }).toBe(zoomed)
        await page.waitForTimeout(800)

        // Nobody looked at the hidden sessions, so none of them re-measured its font…
        for (const id of [HIDDEN, ...OTHERS]) {
            expect(await fontSize(page, id), `${id} is hidden and must keep its font`).toBe(startFont)
        }
        // …and the hidden program saw no resize; its view still matches its pty (T41's invariant).
        expect(readSizes(file), 'a hidden session gets no SIGWINCH from a zoom').toHaveLength(1)
        expect(await viewSize(page, HIDDEN)).toEqual(hiddenBefore)

        // Shown: the font lands, then one fit — one SIGWINCH for three presses, at the size the view now has.
        await activateSession(page, 'T54HIDDEN')
        await expect.poll(() => fontSize(page, HIDDEN), { timeout: 5_000 }).toBe(zoomed)
        await page.waitForTimeout(1500)
        const sizes = readSizes(file)
        const shown = await viewSize(page, HIDDEN)
        expect(sizes, 'showing after three presses resizes the pty once').toHaveLength(2)
        expect(sizes[1]).toEqual(shown)
        expect(shown.cols, 'a smaller font fits more columns').toBeGreaterThan(hiddenBefore.cols)
        expect(shown, 'same box and font as the terminal that was visible').toEqual(await viewSize(page, VISIBLE))

        // The other hidden sessions still wait.
        for (const id of OTHERS) expect(await fontSize(page, id)).toBe(startFont)
    })
})
