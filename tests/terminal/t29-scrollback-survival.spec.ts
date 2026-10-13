import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, termText, writeToTerminal, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T29 — terminal history outlives the view that showed it.
 *
 * The renderer's xterm is the only thing the user sees, but it is not where
 * history lives: the main-process mirror keeps it, and ScrollbackStore keeps
 * it on disk. Each test takes one way the view goes away while the session
 * matters to the user:
 *  - the renderer crashes (memory pressure shows a white window) — the app
 *    reloads it on its own;
 *  - the window is closed and reopened while the app keeps running;
 *  - the app is force-quit and started again.
 *
 * A view that finds its pty already running must not type the start or resume
 * command again: whatever runs there takes it as input. On 2026-10-12 a
 * reopened window typed `cldy --resume <id>` into four live Claude sessions,
 * which sent it as part of the next prompt. The `resume-count` file counts how
 * often that command ran.
 */

const MARKER_LINES = 300
const RESUME_ID = '29292929-2929-2929-2929-292929292929'
const SAVE_INTERVAL_MS = 500
const RESTORED_MARKER = 'Restored from previous session'

function seedClaudeTranscript(sessionId: string): string {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t29-claude-'))
    const projectDir = path.join(configDir, 'projects', 'seeded-project')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.writeFileSync(path.join(projectDir, `${sessionId}.jsonl`), '{"type":"seed"}\n')
    return configDir
}

function countLines(file: string): number {
    if (!fs.existsSync(file)) return 0
    return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).length
}

async function waitForTerminals(page: Page, expected: number): Promise<void> {
    await page.waitForFunction(
        (n: number) => {
            const dbg = (window as unknown as { __termDebug?: { ids: () => string[] } }).__termDebug
            return Boolean(dbg && dbg.ids().length >= n)
        },
        expected,
        { timeout: 30_000 }
    )
}

test.describe('T29 scrollback survival', () => {
    let ctx: LaunchResult | null = null
    let relaunched: ElectronApplication | null = null
    const temps: string[] = []

    test.afterEach(async () => {
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        if (ctx) await closeApp(ctx)
        ctx = null
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    /** Two sessions: a plain shell that printed MARKER_LINES lines, and a tracked agent session that resumed once. */
    async function seed(): Promise<{ dir: string; env: Record<string, string> }> {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t29-'))
        temps.push(dir)
        const claudeConfigDir = seedClaudeTranscript(RESUME_ID)
        temps.push(claudeConfigDir)
        const env = { CLAUDE_CONFIG_DIR: claudeConfigDir, CLIMANAGER_SCROLLBACK_SAVE_MS: String(SAVE_INTERVAL_MS) }
        ctx = await launchAppWithWorkspaces([{
            id: 'ws', name: 'T29WS', path: dir,
            sessions: [
                { id: 's-shell', name: 'T29SHELL' },
                {
                    id: 's-tpl',
                    name: 'T29TPL',
                    initialCommand: `echo i >> ${dir}/init-count; echo T29-FRESH`,
                    cliSessionId: RESUME_ID,
                    cliToolName: 'claude',
                    cliCommand: `echo r >> ${dir}/resume-count; echo T29-RESUMED`
                }
            ]
        }], { env })

        await ctx.page.locator('[data-session-item="s-tpl"]').click()
        await expect.poll(() => countLines(`${dir}/resume-count`), { timeout: 20_000 }).toBe(1)

        await ctx.page.locator('[data-session-item="s-shell"]').click()
        await ctx.page.waitForTimeout(1500)
        await writeToTerminal(ctx.page, 's-shell', `for i in $(seq 1 ${MARKER_LINES}); do echo T29-LINE-$i; done\r`)
        await expect
            .poll(() => termText(ctx!.page, 's-shell'), { timeout: 20_000 })
            .toContain(`T29-LINE-${MARKER_LINES}`)
        return { dir, env }
    }

    async function expectHistory(page: Page): Promise<string> {
        await waitForTerminals(page, 2)
        await page.locator('[data-session-item="s-shell"]').click()
        await expect.poll(() => termText(page, 's-shell'), { timeout: 15_000 }).toContain(`T29-LINE-${MARKER_LINES}`)
        const text = await termText(page, 's-shell')
        expect(text, 'the oldest marker line too, not just the screen').toMatch(/T29-LINE-1\s/)
        return text
    }

    test('a crashed renderer reloads with history and does not retype commands', async () => {
        const { dir } = await seed()
        const app = ctx!.app

        const reloaded = new Promise<void>((resolve) => {
            void app.evaluate(({ BrowserWindow }) =>
                new Promise<void>((done) => {
                    BrowserWindow.getAllWindows()[0].webContents.once('did-finish-load', () => done())
                })
            ).then(() => resolve())
        })
        await app.evaluate(({ BrowserWindow }) => {
            BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()
        })
        await reloaded

        // Playwright keeps treating the crashed page as dead after the reload,
        // so the reloaded renderer is driven through main instead.
        const inRenderer = <T,>(script: string): Promise<T> =>
            app.evaluate(({ BrowserWindow }, code) => BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(code), script) as Promise<T>
        const shellText = (): Promise<string> =>
            inRenderer<string>(`window.__termDebug?.ids().includes('s-shell') ? window.__termDebug.text('s-shell') : ''`)

        await expect.poll(() => inRenderer<number>(`window.__termDebug ? window.__termDebug.ids().length : 0`), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
        await inRenderer(`document.querySelector('[data-session-item="s-shell"]').click()`)
        await expect.poll(shellText, { timeout: 15_000 }).toContain(`T29-LINE-${MARKER_LINES}`)
        expect(await shellText(), 'the oldest marker line too, not just the screen').toMatch(/T29-LINE-1\s/)

        await new Promise((resolve) => setTimeout(resolve, 1500))
        expect(countLines(`${dir}/resume-count`), 'a live pty must not get its resume command typed again').toBe(1)
        expect(countLines(`${dir}/init-count`)).toBe(0)

        // Live output still reaches the reloaded view after the snapshot.
        await inRenderer(`window.api.writeTerminal('s-shell', 'echo T29-AFTER-RELOAD\\r')`)
        await expect.poll(shellText, { timeout: 10_000 }).toContain('T29-AFTER-RELOAD')
    })

    test('a window reopened while the app runs shows history and does not retype commands', async () => {
        const { dir } = await seed()
        const app = ctx!.app

        const reopened = app.waitForEvent('window')
        await app.evaluate(({ app: electronApp, BrowserWindow }) => {
            BrowserWindow.getAllWindows().forEach((w) => w.destroy())
            electronApp.emit('activate')
        })
        const page = await reopened

        const text = await expectHistory(page)
        expect(text.match(/T29-LINE-300\b/g)?.length, 'history drawn once, not repeated').toBe(1)
        await page.waitForTimeout(1500)
        expect(countLines(`${dir}/resume-count`)).toBe(1)
    })

    test('a force-quit app restores history from disk and resumes once', async () => {
        const { dir, env } = await seed()
        const userDataDir = ctx!.userDataDir
        // Let at least one save interval pass after the output.
        await ctx!.page.waitForTimeout(SAVE_INTERVAL_MS * 4)
        expect(fs.existsSync(path.join(userDataDir, 'scrollback', 's-shell.ans')), 'history saved to disk').toBe(true)

        const proc = ctx!.app.process()
        const exited = new Promise((resolve) => proc.once('exit', resolve))
        proc.kill('SIGKILL')
        await exited
        // closeApp would delete userData; the relaunch below needs it.
        temps.push(userDataDir)
        ctx!.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t29-unused-'))

        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: {
                ...process.env,
                CLIMANGER_TEST_USERDATA: userDataDir,
                CLIMANGER_TERM_DEBUG: '1',
                CLIMANGER_TEST_HEADLESS: '1',
                ...env
            } as Record<string, string>
        })
        const page = await relaunched.firstWindow()

        const text = await expectHistory(page)
        expect(text, 'a marker between restored history and the new run').toContain(RESTORED_MARKER)
        expect(text.indexOf(`T29-LINE-${MARKER_LINES}`)).toBeLessThan(text.indexOf(RESTORED_MARKER))

        await page.locator('[data-session-item="s-tpl"]').click()
        await expect.poll(() => countLines(`${dir}/resume-count`), { timeout: 20_000 }).toBe(2)
        expect(countLines(`${dir}/init-count`), 'a tracked session resumes instead of starting over').toBe(0)
    })

    test('Cmd+K clears history too, and a deleted session takes its history file along', async () => {
        await seed()
        const app = ctx!.app
        const userDataDir = ctx!.userDataDir

        await ctx!.page.evaluate(() => {
            ;(window as unknown as { api: { clearTerminal: (id: string) => void } }).api.clearTerminal('s-shell')
        })
        await ctx!.page.waitForTimeout(500)

        const reopened = app.waitForEvent('window')
        await app.evaluate(({ app: electronApp, BrowserWindow }) => {
            BrowserWindow.getAllWindows().forEach((w) => w.destroy())
            electronApp.emit('activate')
        })
        const page = await reopened
        await waitForTerminals(page, 2)
        await page.locator('[data-session-item="s-shell"]').click()
        await page.waitForTimeout(1500)
        expect(await termText(page, 's-shell'), 'cleared output must not come back').not.toContain('T29-LINE-1')

        const file = path.join(userDataDir, 'scrollback', 's-tpl.ans')
        await expect.poll(() => fs.existsSync(file), { timeout: 10_000 }).toBe(true)
        await page.evaluate(() =>
            (window as unknown as { api: { removeSession: (w: string, s: string) => Promise<unknown> } }).api.removeSession('ws', 's-tpl')
        )
        expect(fs.existsSync(file), 'history of a deleted session is removed').toBe(false)
    })
})
