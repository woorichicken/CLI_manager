import { test, expect, type Frame, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { nextDocZoom } from '../../src/renderer/src/utils/docZoom'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T209 — ⌘+ / ⌘- / ⌘0 in an HTML document shown in the app (5c6ddf8f).
 *
 * Main turns those keys into `terminal-zoom` (the window's own zoom is fixed at 1), so a page had no zoom at all and
 * the keys changed the terminals' font behind it. Now, with the focus in a document (its page, or its preview window
 * or split pane), the keys zoom that document's frame only — the frame element is drawn larger and laid out smaller,
 * as a browser zooms; the page's CSS, its policy and the bridge are untouched (decision 0013). The terminals keep
 * their font (`__termDebug.fontSize`). Keys go in through main (`webContents.sendInputEvent`, as T54).
 *
 * T209_SHOTS=<dir> + T209_LABEL save the zoomed preview.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const CLAUDE = 't209-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c2090'
const LABEL = process.env.T209_LABEL ?? 'after'

test.describe('T209 unit', () => {
    test('nextDocZoom: a browser\'s levels, the ends hold, ⌘0 is 100%', () => {
        expect(nextDocZoom(1, '=')).toBe(1.1)
        expect(nextDocZoom(1.1, '+')).toBe(1.25)
        expect(nextDocZoom(1, '-')).toBe(0.9)
        expect(nextDocZoom(1.25, '0')).toBe(1)
        expect(nextDocZoom(3, '=')).toBe(3)
        expect(nextDocZoom(0.5, '-')).toBe(0.5)
        expect(nextDocZoom(1.2, '='), 'between levels: the next one up').toBe(1.25)
        expect(nextDocZoom(1.2, '-'), 'between levels: the next one down').toBe(1.1)
        expect(nextDocZoom(1, 'x')).toBeNull()
    })
})

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
})

const chat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')

/** ⌘<key> through the native input path, so main's `before-input-event` sees it (Playwright's keyboard does not reach it). */
async function zoomKey(result: LaunchResult, key: string): Promise<void> {
    await result.app.evaluate(({ BrowserWindow }, keyCode) => {
        const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes('index.html')) ?? BrowserWindow.getAllWindows()[0]
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['meta'] })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['meta'] })
    }, key)
    await result.page.waitForTimeout(250)
}

const fontSize = (page: Page, id: string): Promise<number | null> =>
    page.evaluate((sessionId) => (window as unknown as { __termDebug: { fontSize: (id: string) => number | null } }).__termDebug.fontSize(sessionId), id)

async function frameOf(page: Page, scope = page.locator('body')): Promise<Frame> {
    const handle = await scope.getByTestId('html-doc-frame').elementHandle({ timeout: 15_000 })
    const frame = await handle?.contentFrame()
    if (!frame) throw new Error('no document frame')
    return frame
}

/**
 * How much larger the frame is drawn than it is laid out — the zoom as the window shows it. (Playwright's boxes for
 * elements inside an out-of-process frame leave the frame element's own transform out, so they cannot tell.)
 */
const drawnScale = (frameElement: import('@playwright/test').Locator): Promise<number> =>
    frameElement.evaluate((el) => el.getBoundingClientRect().width / (el as HTMLElement).offsetWidth)

test('T209 app: ⌘+ ⌘+ zooms the focused document only, ⌘0 brings it back, ⌘- in a split pane; the terminals keep their font', async () => {
    test.setTimeout(180_000)
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't209-')))
    const project = path.join(dir, 'project')
    fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(
        path.join(project, 'report.html'),
        '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Zoom review</title><style>body{font:14px -apple-system,sans-serif;margin:24px}</style></head>' +
            '<body><h1 id="title">Zoom review</h1><ul><li>first point</li><li>second point</li></ul></body></html>\n'
    )
    const claudeDir = path.join(dir, 'claude')
    const transcript = path.join(claudeDir, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    const ts = (n: number): string => new Date(Date.UTC(2026, 10, 28, 1, 0, n)).toISOString()
    fs.writeFileSync(
        transcript,
        [
            { type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: ts(1), message: { role: 'user', content: 'Where is the review?' } },
            { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000002', timestamp: ts(2), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'It is `report.html`.' }] } }
        ]
            .map((entry) => JSON.stringify(entry))
            .join('\n') + '\n'
    )
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t209', name: 'T209 project', path: project, sessions: [{ id: CLAUDE, name: 'T209 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --continue --mode-row none` }] }],
        { env: { CLAUDE_CONFIG_DIR: claudeDir, ARTIFACT_DOCK_SOCKET: path.join(dir, 'no-dock.sock') } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    await page.getByText('T209 Claude', { exact: true }).first().click()
    const startFont = (await fontSize(page, CLAUDE))!
    expect(startFont).toBeGreaterThan(0)
    await page.getByTestId('view-toggle-chat').click()
    await chat(page).getByRole('button', { name: 'report.html', exact: true }).first().click()

    const preview = page.getByTestId('chat-file-preview')
    const frameElement = preview.getByTestId('html-doc-frame')
    await expect(frameElement).toBeVisible({ timeout: 15_000 })
    const frame = await frameOf(page, preview)
    await expect(frame.locator('#title')).toHaveText('Zoom review')
    expect(await drawnScale(frameElement)).toBeCloseTo(1, 2)
    const plainWidth = await frame.evaluate(() => innerWidth)

    // a press in the page, then ⌘+ twice: 110% → 125%, drawn larger, laid out narrower — as a browser zooms
    await frame.locator('li').first().click()
    await zoomKey(result, '=')
    await zoomKey(result, '=')
    await expect(frameElement).toHaveAttribute('data-zoom', '1.25')
    await expect(preview.getByTestId('html-doc-zoom')).toHaveText('125%')
    if (process.env.T209_SHOTS) {
        fs.mkdirSync(process.env.T209_SHOTS, { recursive: true })
        await page.screenshot({ path: path.join(process.env.T209_SHOTS, `zoomed-${LABEL}.png`), clip: { x: 0, y: 0, width: 1280, height: 765 } })
    }
    expect(await drawnScale(frameElement)).toBeCloseTo(1.25, 2)
    expect((await frame.evaluate(() => innerWidth)) / plainWidth).toBeCloseTo(0.8, 1)
    // the frame still fits the window: nothing spills past it
    const outer = (await preview.getByTestId('file-preview-page').boundingBox())!
    const drawn = (await frameElement.boundingBox())!
    expect(Math.abs(drawn.x + drawn.width - (outer.x + outer.width))).toBeLessThan(2)
    // the page kept its focus and its words
    expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('html-doc-frame')

    // ⌘0: 100% again
    await zoomKey(result, '0')
    await expect(frameElement).toHaveAttribute('data-zoom', '1')
    await expect(preview.getByTestId('html-doc-zoom')).toHaveCount(0)
    expect(await drawnScale(frameElement)).toBeCloseTo(1, 2)

    // Side by side: the split pane's document zooms from its own frame
    await preview.getByTestId('file-preview-side-by-side').click()
    const pane = page.locator('[data-doc-pane]')
    await expect(pane).toBeVisible({ timeout: 10_000 })
    const paneFrame = await frameOf(page, pane)
    await paneFrame.locator('li').first().click()
    await zoomKey(result, '-')
    await expect(pane.getByTestId('html-doc-frame')).toHaveAttribute('data-zoom', '0.9')

    // the terminals were never zoomed: back on the terminal, its font is the one it started with
    await page.locator('[data-session-item="t209-claude"]').first().click()
    await page.getByTestId('view-toggle-terminal').first().click()
    await page.waitForTimeout(500)
    expect(await fontSize(page, CLAUDE)).toBe(startFont)

    // with the focus out of any document the keys are the terminals' again
    await page.locator('.xterm:visible').first().click()
    await zoomKey(result, '=')
    await expect.poll(() => fontSize(page, CLAUDE)).toBeGreaterThan(startFont)
    await zoomKey(result, '0')
})
