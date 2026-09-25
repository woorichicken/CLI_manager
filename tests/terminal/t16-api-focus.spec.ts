import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T16 — showing an AI session must not hand it the user's keyboard.
 *
 * The Control API can ask the app to switch to a session (`focus: true`). The
 * switch itself is wanted; taking the caret is not — the user may be typing in
 * another terminal. Measured 2026-09-25 before the fix: opening with
 * `focus: true` pulled focus out of the terminal being typed in and did not
 * land it anywhere, so the next keystrokes went nowhere.
 *
 * Switching the view always costs the caret — a terminal inside a hidden
 * container is blurred by the browser, and nothing can hold it. So the test
 * pins the two facts that are ours to control: a quiet open moves nothing, and
 * a requested switch does not hand the caret to the agent.
 *
 * The signal is xterm's own `.focus` class, read from the DOM. `document
 * .activeElement` is useless here: the test window is hidden, so it stays on
 * `body` even while a terminal is focused.
 */
test.describe('T16 API focus', () => {
    let ctx: LaunchResult
    const temps: string[] = []
    const tempDir = (p: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), p))
        temps.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('an AI-requested switch shows the session without stealing the caret', async () => {
        const home = tempDir('climanger-t16-home-')
        const folder = tempDir('climanger-t16-ws-')

        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws', name: 'T16WS', path: folder, sessions: [{ id: 's-user', name: 'T16USER' }] }],
            { settings: { controlApi: { enabled: true, port: 0 } }, env: { CLIMANAGER_HOME: home } }
        )
        const { page } = ctx

        await expect.poll(() => fs.existsSync(path.join(home, 'control-api.json')), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(path.join(home, 'control-api.json'), 'utf-8'))
        const open = async (body: unknown): Promise<string> => {
            const res = await fetch(`${discovery.url}/v1/sessions`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            })
            return (await res.json()).session.id
        }

        /** Which session holds the keyboard, by xterm's own focus class. */
        const focused = (): Promise<string> => page.evaluate(() =>
            Array.from(document.querySelectorAll('.xterm.focus'))
                .map((el) => el.closest('[data-session-id]')?.getAttribute('data-session-id') ?? '?')
                .join(',') || 'none')

        // The user is typing in their own terminal.
        await page.locator('[data-session-item="s-user"]').click()
        await page.locator('[data-session-id="s-user"] .xterm-helper-textarea').focus()
        await page.keyboard.type('user is typing')
        await expect.poll(focused, { timeout: 5_000 }).toBe('s-user')

        // Opening quietly must not move anything.
        const quiet = await open({ path: folder, command: 'echo quiet', name: 'T16QUIET' })
        await page.locator(`[data-session-item="${quiet}"]`).waitFor({ timeout: 15_000 })
        await page.waitForTimeout(1_000)
        expect(await focused(), 'a session opened without focus must not move the caret').toBe('s-user')

        // Opening with focus switches the view, and leaves the caret where it was.
        const shown = await open({ path: folder, command: 'echo shown', name: 'T16SHOWN', focus: true })
        await page.locator(`[data-session-item="${shown}"]`).waitFor({ timeout: 15_000 })
        await expect.poll(
            () => page.locator(`[data-session-id="${shown}"]`).evaluate((el) => getComputedStyle(el).visibility),
            { timeout: 10_000 }
        ).toBe('visible')
        // Switching always costs the caret: a terminal inside a hidden container
        // is blurred by the browser, so nothing can keep it. What must not happen
        // is the AI's terminal picking it up — that would send the user's next
        // keystrokes into the agent's prompt.
        expect(await focused(), "the AI's terminal must not pick up the caret").not.toBe(shown)

        expect(ctx.pageErrors).toEqual([])
    })
})
