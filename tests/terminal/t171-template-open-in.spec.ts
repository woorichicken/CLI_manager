import { test, expect, _electron as electron, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, REPO_ROOT, resizeMainWindow, type LaunchResult } from './helpers'
import type { TerminalSession, TerminalTemplate, Workspace } from '../../src/shared/types'

/**
 * T171 — each template says how its new sessions first show: Terminal or Chat (fbe10f54).
 *
 *  - Settings › Templates › edit has «Open in» (Terminal default); Chat is stored as `openIn: 'chat'`
 *  - a session made from that template afterwards opens on Chat — from the folder menu, ⌘T + number and the
 *    Control API alike; a template without it still opens on the terminal
 *  - a session that already existed keeps its view, even if it came from the same template
 *  - a Chat with no conversation yet shows its empty state, not a broken view
 *
 * The agent is a stand-in `claude` on a temporary PATH running the Chat mock (as T159). T171_SHOTS +
 * T171_LABEL save the template dialog before the checks.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T171_LABEL ?? 'run'
const CHAT_TEMPLATE: TerminalTemplate = { id: 'tpl-t171-chat', name: 'T171Chat', icon: 'terminal', description: '', command: 'claude' }
const TERMINAL_TEMPLATE: TerminalTemplate = { id: 'tpl-t171-term', name: 'T171Term', icon: 'code', description: '', command: 'claude' }
const SHELL_TEMPLATE: TerminalTemplate = { id: 'tpl-t171-shell', name: 'T171Shell', icon: 'play', description: '', command: 'echo T171-SHELL', openIn: 'chat' }
const OLD = { id: 's-t171-old', name: 'T171OLD' }

function makeSandbox(): { root: string; home: string; claudeDir: string; bin: string; project: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't171-'))
    const home = path.join(root, 'home')
    const claudeDir = path.join(root, 'claude-config')
    const bin = path.join(root, 'bin')
    const project = path.join(root, 'my-project')
    for (const dir of [home, claudeDir, bin, project]) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(home, '.zshrc'), `export PATH=${JSON.stringify(bin)}:$PATH\n`)
    const fake = path.join(bin, 'claude')
    fs.writeFileSync(fake, [
        `#!${process.execPath}`,
        "const fs = require('fs'), path = require('path')",
        "const at = process.argv.indexOf('--session-id')",
        "const id = at > 0 ? process.argv[at + 1] : 'no-id'",
        "const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake')",
        'fs.mkdirSync(dir, { recursive: true })',
        `process.argv = [process.argv[0], ${JSON.stringify(MOCK)}, '--transcript', path.join(dir, id + '.jsonl')]`,
        `require(${JSON.stringify(MOCK)})`
    ].join('\n'))
    fs.chmodSync(fake, 0o755)
    return { root, home, claudeDir, bin, project }
}

const readConfig = (dir: string): { workspaces: Workspace[]; customTemplates: TerminalTemplate[] } => JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'))
const sessionsOf = (dir: string): TerminalSession[] => readConfig(dir).workspaces.flatMap((w) => w.sessions)
const row = (page: Page, id: string): Locator => page.locator(`[data-session-item="${id}"]`).first()

let ctx: LaunchResult | null = null
let relaunched: ElectronApplication | null = null
let root = ''
test.afterEach(async () => {
    if (relaunched) await relaunched.close().catch(() => undefined)
    relaunched = null
    if (ctx) await closeApp(ctx)
    ctx = null
    if (root) fs.rmSync(root, { recursive: true, force: true })
    root = ''
})

test('T171 a template that opens in Chat starts its new sessions on Chat — and only those', async () => {
    test.setTimeout(240_000)
    const box = makeSandbox()
    root = box.root
    // the older session came from the same template but predates the setting; it runs the mock the seeded way
    const transcript = path.join(box.claudeDir, 'projects', 'x', '00000000-0000-4000-8000-0000000c1710.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    ctx = await launchAppWithWorkspaces(
        [
            {
                id: 'ws-t171',
                name: 'T171WS',
                path: box.project,
                sessions: [
                    {
                        ...OLD,
                        cliSessionId: '00000000-0000-4000-8000-0000000c1710',
                        cliToolName: 'claude',
                        cliCommand: `node ${MOCK} --transcript ${transcript}`
                    }
                ]
            }
        ],
        {
            customTemplates: [CHAT_TEMPLATE, TERMINAL_TEMPLATE, SHELL_TEMPLATE],
            settings: { showHomeWorkspace: false, controlApi: { enabled: true, port: 0 } },
            env: {
                HOME: box.home,
                CLAUDE_CONFIG_DIR: box.claudeDir,
                CODEX_HOME: path.join(box.root, 'codex-home'),
                PATH: `${box.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
                SHELL: '/bin/zsh',
                CLIMANAGER_HOME: box.home
            }
        }
    )
    const { app, page, userDataDir } = ctx
    await resizeMainWindow(app, 1280, 800)
    const created = (): TerminalSession[] => sessionsOf(userDataDir).filter((s) => s.id !== OLD.id)

    // --- the template dialog -------------------------------------------------------------------
    await page.locator('button[title^="Settings"]').first().click()
    await page.getByRole('button', { name: 'Templates', exact: true }).click()
    await page.getByText(CHAT_TEMPLATE.name, { exact: true }).first().waitFor()
    await page.locator('button[title="Edit"]').first().click()
    const dialog = page.getByTestId('template-edit-dialog')
    await expect(dialog).toBeVisible()
    if (process.env.T171_SHOTS) {
        fs.mkdirSync(process.env.T171_SHOTS, { recursive: true })
        await page.waitForTimeout(300)
        await page.screenshot({ path: path.join(process.env.T171_SHOTS, `template-dialog-${LABEL}.png`) })
    }
    await expect(dialog.getByTestId('template-open-in-terminal')).toHaveAttribute('aria-checked', 'true')
    await dialog.getByTestId('template-open-in-chat').click()
    await expect(dialog.getByTestId('template-open-in-chat')).toHaveAttribute('aria-checked', 'true')
    await dialog.getByRole('button', { name: 'Save Template' }).click()
    await page.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(page.getByRole('button', { name: 'Templates', exact: true })).toHaveCount(0)
    await expect.poll(() => readConfig(userDataDir).customTemplates.find((t) => t.id === CHAT_TEMPLATE.id)?.openIn).toBe('chat')
    expect(readConfig(userDataDir).customTemplates.find((t) => t.id === TERMINAL_TEMPLATE.id)).not.toHaveProperty('openIn')

    // --- the session that existed stays on its terminal ---------------------------------------
    await row(page, OLD.id).click()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')

    // --- folder menu, Chat template: the new session opens on Chat ----------------------------
    await page.getByText('T171WS', { exact: true }).first().click({ button: 'right' })
    await page.getByRole('button', { name: CHAT_TEMPLATE.name }).first().click()
    await expect.poll(() => created().length).toBe(1)
    const fromMenu = created()[0]
    expect(fromMenu.templateId).toBe(CHAT_TEMPLATE.id)
    // switched once, the hint is spent: main deleted it from the stored session
    await expect.poll(() => sessionsOf(userDataDir).find((s) => s.id === fromMenu.id)?.openInChat).toBeUndefined()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'chat', { timeout: 60_000 })
    // the agent just started and wrote no conversation: the empty state shows, not a broken view
    const chat = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    await expect(chat.getByTestId('chat-composer')).toBeVisible({ timeout: 30_000 })
    await expect(chat.getByText('No conversation yet')).toBeVisible()

    // --- the other template stays on the terminal ----------------------------------------------
    await page.getByText('T171WS', { exact: true }).first().click({ button: 'right' })
    await page.getByRole('button', { name: TERMINAL_TEMPLATE.name }).first().click()
    await expect.poll(() => created().length).toBe(2)
    const plain = created().find((s) => s.id !== fromMenu.id)!
    expect(plain.openInChat).toBeUndefined()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal', { timeout: 60_000 })

    // --- a Chat template whose command is no agent: no flag, and the view stays the terminal ------
    await page.getByText('T171WS', { exact: true }).first().click({ button: 'right' })
    await page.getByRole('button', { name: SHELL_TEMPLATE.name }).first().click()
    await expect.poll(() => created().length).toBe(3)
    const shell = created().find((s) => s.id !== fromMenu.id && s.id !== plain.id)!
    expect(shell.templateId).toBe(SHELL_TEMPLATE.id)
    expect(shell.openInChat).toBeUndefined()
    await page.waitForTimeout(800)
    expect(await page.evaluate((id) => JSON.parse(localStorage.getItem('session-view-modes') ?? '{}')[id] ?? 'terminal', shell.id)).toBe('terminal')

    // --- ⌘T + 1 (the first template is the Chat one) --------------------------------------------
    await row(page, OLD.id).click()
    await page.keyboard.press('Meta+t')
    await page.keyboard.press('1')
    await expect.poll(() => created().length).toBe(4)
    const fromShortcut = created().find((s) => ![fromMenu.id, plain.id, shell.id].includes(s.id))!
    expect(fromShortcut.templateId).toBe(CHAT_TEMPLATE.id)
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'chat', { timeout: 60_000 })

    // --- Control API `template`: Chat when it first shows --------------------------------------
    const discoveryPath = path.join(box.home, 'control-api.json')
    await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as { url: string; token: string }
    const res = await fetch(discovery.url + '/v1/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't171' },
        body: JSON.stringify({ path: box.project, template: CHAT_TEMPLATE.name, name: 'T171API' })
    })
    expect(res.status).toBe(200)
    const apiId = ((await res.json()) as { session: { id: string } }).session.id
    await expect.poll(() => sessionsOf(userDataDir).some((s) => s.id === apiId)).toBe(true)
    await row(page, apiId).click()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'chat', { timeout: 60_000 })

    // --- the person's own choice wins afterwards, and the old session was never touched ----------
    await expect.poll(() => sessionsOf(userDataDir).find((s) => s.id === apiId)?.openInChat).toBeUndefined()
    await page.getByTestId('view-toggle-terminal').click()
    await row(page, OLD.id).click()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')
    await row(page, apiId).click()
    await expect(page.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal')

    // --- restart with the renderer's storage wiped: no flag in config.json, still Terminal ----------
    const keptDir = userDataDir
    await ctx.app.close()
    fs.rmSync(path.join(keptDir, 'Local Storage'), { recursive: true, force: true })
    ctx.userDataDir = path.join(keptDir, '..', 'climanger-t171-unused')
    relaunched = await electron.launch({
        args: [path.join(REPO_ROOT, 'out/main/index.js')],
        env: {
            ...process.env,
            CLIMANGER_TEST_USERDATA: keptDir,
            CLIMANGER_TERM_DEBUG: '1',
            CLIMANGER_TEST_HEADLESS: '1',
            HOME: box.home,
            CLAUDE_CONFIG_DIR: box.claudeDir,
            PATH: `${box.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
            SHELL: '/bin/zsh',
            CLIMANAGER_HOME: box.home
        } as Record<string, string>
    })
    const page2 = await relaunched.firstWindow()
    await page2.setViewportSize({ width: 1280, height: 800 })
    await row(page2, apiId).click({ timeout: 30_000 })
    await expect(page2.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal', { timeout: 60_000 })
    await row(page2, fromMenu.id).click()
    await expect(page2.getByTestId('view-toggle')).toHaveAttribute('data-mode', 'terminal', { timeout: 60_000 })
    for (const id of [fromMenu.id, apiId, fromShortcut.id]) {
        expect(sessionsOf(keptDir).find((s) => s.id === id)?.openInChat, 'no flag left in config.json').toBeUndefined()
    }
})
