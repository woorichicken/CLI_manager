import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    launchAppWithSessions,
    closeApp,
    activateSession,
    writeToTerminal,
    termText,
    REPO_ROOT,
    LaunchResult
} from './helpers'

/**
 * T14 — what a click in the terminal is allowed to do.
 *
 * Two regressions live here, both invisible from the code:
 *
 * 1. Codex hands out links as OSC 8 hyperlinks, not bare URLs. xterm serves
 *    those from its own provider, and with no `linkHandler` its default is
 *    confirm() + window.open() with no URL — which Electron's window-open
 *    handler denies. The link highlights, the click does nothing.
 *
 * 2. xterm activates link providers on a plain click. Opening an editor from
 *    that pulls the editor window in front of this one, so placing the cursor
 *    in the terminal would yank focus away. File paths need a modifier.
 *
 * Both are asserted at the far end of the chain: shell.openExternal is stubbed
 * in the main process, and the editor is a script that records its arguments.
 */

const LINK_URL = 'https://example.com/t14-osc8'

/**
 * Click where the given text is painted. xterm has no clickable node per cell
 * and repaints rows as it goes, so this resolves coordinates on the spot rather
 * than holding a locator.
 */
async function clickText(
    page: import('@playwright/test').Page,
    needle: string,
    modifiers: string[] = []
): Promise<void> {
    const findBox = () => page.evaluate((text) => {
        const nodes = Array.from(document.querySelectorAll('.xterm-rows *'))
            .filter(n => (n.textContent || '').includes(text))
        const el = nodes[nodes.length - 1]
        if (!el) return null
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return null
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }, needle)

    let box: { x: number, y: number } | null = null
    const deadline = Date.now() + 20_000
    while (!box && Date.now() < deadline) {
        box = await findBox()
        if (!box) await page.waitForTimeout(200)
    }
    if (!box) throw new Error(`"${needle}" was never painted in a row element`)

    for (const key of modifiers) await page.keyboard.down(key)
    await page.mouse.move(box.x, box.y)
    await page.waitForTimeout(200) // let xterm resolve the link under the cursor
    await page.mouse.click(box.x, box.y)
    for (const key of modifiers) await page.keyboard.up(key)
    await page.waitForTimeout(800)
}

test.describe('T14 terminal links', () => {
    let ctx: LaunchResult
    let editorLog: string
    let fakeEditor: string
    let tempDir: string

    test.beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t14-'))
        editorLog = path.join(tempDir, 'editor-invocations.log')
        fakeEditor = path.join(tempDir, 'fake-editor.sh')
        fs.writeFileSync(fakeEditor, `#!/bin/sh\necho "$@" >> "${editorLog}"\n`)
        fs.chmodSync(fakeEditor, 0o755)
    })

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        fs.rmSync(tempDir, { recursive: true, force: true })
    })

    test('an OSC 8 hyperlink opens externally when clicked', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t14', name: 'T14SESS' }])
        const { app, page } = ctx

        // Record instead of opening a browser.
        await app.evaluate(({ shell }) => {
            const opened: string[] = []
            ;(globalThis as unknown as { __opened: string[] }).__opened = opened
            shell.openExternal = async (url: string) => { opened.push(url) }
        })

        await activateSession(page, 'T14SESS')

        // printf emits the escape sequence itself; writeTerminal talks to the
        // shell, so the sequence has to come from a command rather than inline.
        await writeToTerminal(
            page,
            'sess-t14',
            `printf '\\033]8;;${LINK_URL}\\033\\\\T14CLICKME\\033]8;;\\033\\\\\\n'\n`
        )
        await expect.poll(() => termText(page, 'sess-t14'), { timeout: 20_000 }).toContain('T14CLICKME')

        await clickText(page, 'T14CLICKME')

        const opened = await app.evaluate(() =>
            (globalThis as unknown as { __opened: string[] }).__opened)
        expect(opened).toContain(LINK_URL)
    })

    test('a file path opens the editor only with the modifier held', async () => {
        ctx = await launchAppWithSessions([{ id: 'sess-t14b', name: 'T14SESSB' }])
        const { page } = ctx

        // Main reads the editor command from the store, so persisting is enough.
        await page.evaluate(async (editorPath) => {
            const api = (window as unknown as {
                api: {
                    getSettings: () => Promise<Record<string, unknown>>
                    saveSettings: (s: Record<string, unknown>) => Promise<unknown>
                }
            }).api
            const current = await api.getSettings()
            await api.saveSettings({ ...current, defaultEditor: 'custom', customEditorPath: editorPath })
        }, fakeEditor)

        await activateSession(page, 'T14SESSB')

        // A path that really exists, so the main process gets as far as running
        // the editor — otherwise this would pass for the wrong reason.
        await writeToTerminal(page, 'sess-t14b', `printf 'edited src/main/index.ts:42\\n'\n`)
        await expect.poll(() => termText(page, 'sess-t14b'), { timeout: 20_000 })
            .toContain('src/main/index.ts:42')

        await clickText(page, 'src/main/index.ts:42')
        expect(fs.existsSync(editorLog), 'a plain click must not launch the editor').toBe(false)

        await clickText(page, 'src/main/index.ts:42', ['Meta'])
        await expect.poll(() => fs.existsSync(editorLog), { timeout: 10_000 }).toBe(true)
        expect(fs.readFileSync(editorLog, 'utf-8')).toContain(path.join(REPO_ROOT, 'src/main/index.ts'))
    })
})
