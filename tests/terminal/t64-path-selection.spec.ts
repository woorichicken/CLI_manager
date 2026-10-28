import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, writeToTerminal, termText, LaunchResult } from './helpers'

/**
 * T64 — a partial selection of a path opens the WHOLE path, and a path broken by Claude Code's indented
 * continuation copies as one path (reports 09eff960 · 06db516a · 85703148).
 *
 * The shell prints a path the way Claude Code does: the first row is exactly $COLUMNS cells, the rest follows on
 * the next row after a two-space indent (a real line break, not a soft wrap). Selection is done with the real
 * mouse; Finder is judged at the far end (main's shell.showItemInFolder is stubbed) and the clipboard is read
 * in main and restored afterwards.
 */

const SESSION = 'sess-t64'
const FILE_NAME = '1-비교표-시안.jpg'
/** The break must land inside the folder name, and the rest must still fit one row (so the path is exactly two rows). */
const BREAK_OVERSHOOT = 25

/** Terminal cells a string paints: Hangul syllables are two wide. */
function cells(text: string): number {
    let n = 0
    for (const ch of text) n += /[가-힣]/.test(ch) ? 2 : 1
    return n
}

interface RowBox { top: number; height: number; left: number; cellWidth: number }

/** The last two painted rows holding the long run of x — the printed path (the echoed command has none). */
async function pathRows(page: Page, cols: number): Promise<[RowBox, RowBox]> {
    const rows = await page.evaluate(([marker, cols]) => {
        const out: RowBox[][] = []
        for (const screen of Array.from(document.querySelectorAll('.xterm-screen'))) {
            if (getComputedStyle(screen.closest('[data-session-id]') ?? screen).visibility === 'hidden') continue
            const rowsEl = screen.querySelector('.xterm-rows')
            if (!rowsEl) continue
            const screenRect = screen.getBoundingClientRect()
            const hit = Array.from(rowsEl.children).filter((r) => (r.textContent ?? '').includes(marker))
            out.push(hit.slice(-2).map((r) => {
                const rect = r.getBoundingClientRect()
                return { top: rect.top, height: rect.height, left: screenRect.left, cellWidth: cols ? screenRect.width / cols : 0 }
            }))
        }
        return out.find((r) => r.length === 2) ?? []
    }, ['x'.repeat(20), cols] as const)
    if (rows.length !== 2) throw new Error('printed path rows not found')
    return rows as [RowBox, RowBox]
}

async function columns(page: Page): Promise<number> {
    const state = await page.evaluate((id) =>
        (window as unknown as { __termDebug: { state: (id: string) => { cols: number } | null } }).__termDebug.state(id), SESSION)
    if (!state) throw new Error('no terminal state')
    return state.cols
}

test.describe('T64 path selection', () => {
    let ctx: LaunchResult
    let dir: string
    let fullPath: string
    let editorLog: string

    test.beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't64-')))
        editorLog = path.join(dir, 'editor.log')
    })

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test('mid-path drags reveal the whole path; a broken path copies as one path', async () => {
        const fakeEditor = path.join(dir, 'fake-editor.sh')
        fs.writeFileSync(fakeEditor, `#!/bin/sh\necho "$PWD|$*" >> "${editorLog}"\n`)
        fs.chmodSync(fakeEditor, 0o755)
        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t64', name: 'T64WS', path: dir, sessions: [{ id: SESSION, name: 'T64SESS', cwd: dir }] }],
            { settings: { defaultEditor: 'custom', customEditorPath: fakeEditor, showHomeWorkspace: false } }
        )
        const { app, page } = ctx
        await app.evaluate(({ shell }) => {
            const shown: string[] = []
            ;(globalThis as unknown as { __shown: string[] }).__shown = shown
            shell.showItemInFolder = (fullPathArg: string) => { shown.push(fullPathArg) }
        })
        const shown = () => app.evaluate(() => (globalThis as unknown as { __shown: string[] }).__shown)
        const editorCalls = () => (fs.existsSync(editorLog) ? fs.readFileSync(editorLog, 'utf8').trim().split('\n') : [])

        await activateSession(page, 'T64SESS')
        await page.waitForTimeout(500)

        const cols = await columns(page)
        const folder = path.join(dir, 'x'.repeat(cols + BREAK_OVERSHOOT - dir.length - 1))
        fs.mkdirSync(folder)
        fullPath = path.join(folder, FILE_NAME)
        fs.writeFileSync(fullPath, 'x')
        fs.writeFileSync(path.join(dir, 'print.sh'), [
            `p='${fullPath}'`,
            'printf \'%s\\n  %s\\n\' "${p:0:$COLUMNS}" "${p:$COLUMNS}"',
            ''
        ].join('\n'))
        await writeToTerminal(page, SESSION, 'source ./print.sh\r')
        await expect.poll(() => termText(page, SESSION), { timeout: 15_000 }).toContain(FILE_NAME)

        const rest = fullPath.slice(cols)
        expect(rest.length).toBeGreaterThan(FILE_NAME.length) // the break really lands inside the folder name
        const [first, second] = await pathRows(page, cols)
        const cellW = first.cellWidth
        const xAt = (cell: number) => first.left + (cell + 0.5) * cellW
        const yOf = (row: RowBox) => row.top + row.height / 2
        const selectionNow = () => page.evaluate((id) =>
            (window as unknown as { __termDebug: { selection: (id: string) => string | null } }).__termDebug.selection(id), SESSION)

        // 85703148: only a piece of the first row (the front of the path) is dragged.
        await page.mouse.move(xAt(4), yOf(first))
        await page.mouse.down()
        await page.mouse.move(xAt(30), yOf(first), { steps: 6 })
        await page.mouse.up()
        await expect.poll(selectionNow).toBe(fullPath.slice(4, 30))
        await page.keyboard.press('Meta+Shift+O')
        await expect.poll(shown, { timeout: 10_000 }).toEqual([fullPath])

        // 06db516a: just the word 비교표 inside the file name, on the indented second row.
        const restCells = 2 + cells(rest)
        const wordEnd = restCells - cells('-시안.jpg') // first cell after 비교표
        const wordStart = wordEnd - cells('비교표')
        await page.mouse.move(xAt(wordStart), yOf(second))
        await page.mouse.down()
        await page.mouse.move(xAt(wordEnd - 1), yOf(second), { steps: 6 })
        await page.mouse.up()
        await expect.poll(selectionNow).toContain('비교표')
        await page.keyboard.press('Meta+Shift+O')
        await expect.poll(shown, { timeout: 10_000 }).toEqual([fullPath, fullPath])

        // Open in Editor takes the same widened path.
        await page.keyboard.press('Meta+Shift+E')
        await expect.poll(() => editorCalls().length, { timeout: 15_000 }).toBe(1)
        expect(editorCalls()[0]).toContain(fullPath)

        // 09eff960: a drag across the break copies the path without the line break and the indent.
        const readClipboard = () => app.evaluate(({ clipboard }) => clipboard.readText())
        const before = await readClipboard()
        try {
            await page.mouse.move(xAt(cols - 12), yOf(first))
            await page.mouse.down()
            await page.mouse.move(xAt(20), yOf(second), { steps: 8 })
            await page.mouse.up()
            await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.copy() })
            await expect.poll(readClipboard, { timeout: 10_000 }).not.toBe(before)
            const copied = await readClipboard()
            expect(copied).not.toMatch(/\s/)
            expect(fullPath.includes(copied)).toBe(true)
            expect(copied.length).toBeGreaterThan(12)

            // Ordinary multi-row text keeps its line breaks.
            await writeToTerminal(page, SESSION, "clear; printf 'alpha beta\\ngamma delta\\n'\r")
            await expect.poll(() => termText(page, SESSION), { timeout: 15_000 }).toContain('gamma delta')
            const a = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll('.xterm-rows')).filter((r) => getComputedStyle(r.closest('[data-session-id]') ?? r).visibility !== 'hidden')
                const hit = Array.from(rows[0].children).filter((r) => /alpha beta|gamma delta/.test(r.textContent ?? ''))
                return hit.map((r) => { const b = r.getBoundingClientRect(); return { top: b.top, height: b.height } })
            })
            expect(a.length).toBe(2)
            await page.mouse.move(xAt(0), a[0].top + a[0].height / 2)
            await page.mouse.down()
            await page.mouse.move(xAt(9), a[1].top + a[1].height / 2, { steps: 6 })
            await page.mouse.up()
            await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.copy() })
            await expect.poll(readClipboard, { timeout: 10_000 }).toContain('alpha beta')
            expect(await readClipboard()).toMatch(/alpha beta\s*\n\s*gamma/)
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), before)
        }
    })
})
