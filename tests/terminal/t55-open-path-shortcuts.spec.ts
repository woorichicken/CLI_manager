import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, writeToTerminal, termText, LaunchResult } from './helpers'

/**
 * T55 — Reveal in Finder (Cmd+Shift+O) and Open in Editor (Cmd+Shift+E) from the keyboard (report 7d7abfff:
 * "finder 로 열기 / editor 로 열기 단축키 있어야할듯", pinned on a path printed in the terminal).
 *
 * With a path selected in the terminal they do what the right-click menu does with it; with nothing selected
 * they open the session folder. Judged at the far end: shell.showItemInFolder is stubbed in main, and the editor
 * is a script that records its working directory and arguments (opening a folder runs `<editor> .` in it).
 */

const SESSION = 'sess-t55'
const TARGET = 't55-target.txt'

/** Double-clicks the last painted occurrence of the text — xterm selects the word under the pointer. */
async function selectWord(page: Page, needle: string): Promise<void> {
    const box = await page.evaluate((text) => {
        const nodes = Array.from(document.querySelectorAll(`[data-session-id] .xterm-rows *`))
            .filter((n) => (n.textContent || '').includes(text) && getComputedStyle(n).visibility === 'visible')
        const el = nodes[nodes.length - 1]
        if (!el) return null
        const rect = el.getBoundingClientRect()
        // The line is just the path, so its first characters are inside the word.
        return { x: rect.x + 6, y: rect.y + rect.height / 2 }
    }, needle)
    if (!box) throw new Error(`"${needle}" was never painted`)
    await page.mouse.dblclick(box.x, box.y)
}

test.describe('T55 open path shortcuts', () => {
    let ctx: LaunchResult
    let dir: string
    let editorLog: string

    test.beforeEach(() => {
        // realpath: the shell reports /private/var/… for a /var/… temp folder.
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't55-')))
        fs.writeFileSync(path.join(dir, TARGET), 'one\ntwo\nthree\n')
        editorLog = path.join(dir, 'editor.log')
    })

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test('no selection opens the session folder; a selected path opens that path', async () => {
        const fakeEditor = path.join(dir, 'fake-editor.sh')
        fs.writeFileSync(fakeEditor, `#!/bin/sh\necho "$PWD|$*" >> "${editorLog}"\n`)
        fs.chmodSync(fakeEditor, 0o755)

        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-t55', name: 'T55WS', path: dir, sessions: [{ id: SESSION, name: 'T55SESS', cwd: dir }] }],
            { settings: { defaultEditor: 'custom', customEditorPath: fakeEditor, showHomeWorkspace: false } }
        )
        const { app, page } = ctx
        await app.evaluate(({ shell }) => {
            const shown: string[] = []
            ;(globalThis as unknown as { __shown: string[] }).__shown = shown
            shell.showItemInFolder = (fullPath: string) => { shown.push(fullPath) }
        })
        const shown = () => app.evaluate(() => (globalThis as unknown as { __shown: string[] }).__shown)
        const editorCalls = () => (fs.existsSync(editorLog) ? fs.readFileSync(editorLog, 'utf8').trim().split('\n') : [])

        await activateSession(page, 'T55SESS')
        await page.waitForTimeout(500)

        // Nothing selected: the session folder.
        await page.keyboard.press('Meta+Shift+O')
        await expect.poll(shown, { timeout: 10_000 }).toEqual([dir])
        await page.keyboard.press('Meta+Shift+E')
        await expect.poll(editorCalls, { timeout: 15_000 }).toEqual([`${dir}|.`])

        // A path printed in the terminal and selected: that path, like the right-click menu.
        await writeToTerminal(page, SESSION, `printf '%s\\n' ${TARGET}:2\r`)
        await expect.poll(() => termText(page, SESSION), { timeout: 15_000 }).toMatch(new RegExp(`^${TARGET}:2$`, 'm'))
        await selectWord(page, `${TARGET}:2`)
        await expect.poll(() => page.evaluate((id) =>
            (window as unknown as { __termDebug: { selection: (id: string) => string | null } }).__termDebug.selection(id), SESSION))
            .toBe(`${TARGET}:2`)

        await page.keyboard.press('Meta+Shift+O')
        await expect.poll(shown, { timeout: 10_000 }).toEqual([dir, path.join(dir, TARGET)])
        await page.keyboard.press('Meta+Shift+E')
        await expect.poll(() => editorCalls().length, { timeout: 15_000 }).toBe(2)
        // The line number goes to the editor as well (the menu's file:line handling: `<editor> <cwd> -g file:line`).
        expect(editorCalls()[1]).toContain(`-g ${path.join(dir, TARGET)}:2`)
    })
})
