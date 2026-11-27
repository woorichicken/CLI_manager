import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, REPO_ROOT, termText, writeToTerminal, type LaunchResult } from './helpers'

/**
 * T159 Getting started (fb-1120b tutorial decision 3) — the first-run checklist and the folder
 * "+" menu's built-in Claude Code / Codex / Antigravity rows, in the real app:
 *  - the card appears only after the welcome screen's Continue (existing users never see it),
 *  - each tick comes from what happened: a folder added through the picker, `claude` running in
 *    the foreground of a session opened from the built-in row, a first message in its transcript,
 *  - the card moves from the empty main pane to the sidebar foot once a session is open, and
 *    disappears when all four are done (the fourth, «Connect an AI agent», has buttons that act:
 *    turn the Control API on, copy the skill install command, open the API docs),
 *  - a card stored before the fourth step existed never comes back for someone who finished or
 *    closed it; «Show Again» gives them all four,
 *  - a program not found draws its row dim with «Not installed» (main's check is replaced by
 *    CLIMANAGER_AGENT_CLI_FAKE in tests), and it stays clickable.
 *
 * The `claude` started here is a stand-in: a node script named `claude` on a PATH that has no real
 * one (HOME, CLAUDE_CONFIG_DIR and PATH are all temporary), running the Chat tests' mock agent, which
 * writes a Claude-shaped transcript.
 */

const CHAT_MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const SHOTS = process.env.T159_SHOTS
const LABEL = process.env.T159_LABEL ?? 'after'

interface Sandbox {
    root: string
    home: string
    claudeDir: string
    bin: string
    project: string
    /** an isolated ~/.climanager, so the Control API may start */
    climanagerHome: string
}

function makeSandbox(): Sandbox {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 't159-'))
    const home = path.join(root, 'home')
    const claudeDir = path.join(root, 'claude-config')
    const bin = path.join(root, 'bin')
    const project = path.join(root, 'my-project')
    const climanagerHome = path.join(root, 'climanager-home')
    for (const dir of [home, claudeDir, bin, project, climanagerHome]) fs.mkdirSync(dir, { recursive: true })
    // a .zshrc keeps zsh from asking its new-user questions, and puts the stand-in first: macOS
    // path_helper moves /usr/local/bin and /opt/homebrew/bin ahead of the PATH it was given, where a
    // real `claude` may be installed
    fs.writeFileSync(path.join(home, '.zshrc'), `export PATH=${JSON.stringify(bin)}:$PATH\n`)
    const fake = path.join(bin, 'claude')
    fs.writeFileSync(fake, [
        `#!${process.execPath}`,
        "const fs = require('fs'), path = require('path')",
        "const at = process.argv.indexOf('--session-id')",
        "const id = at > 0 ? process.argv[at + 1] : 'no-id'",
        "const dir = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'fake')",
        'fs.mkdirSync(dir, { recursive: true })',
        `process.argv = [process.argv[0], ${JSON.stringify(CHAT_MOCK)}, '--transcript', path.join(dir, id + '.jsonl')]`,
        `require(${JSON.stringify(CHAT_MOCK)})`
    ].join('\n'))
    fs.chmodSync(fake, 0o755)
    return { root, home, claudeDir, bin, project, climanagerHome }
}

async function shot(page: LaunchResult['page'], name: string): Promise<void> {
    if (!SHOTS) return
    fs.mkdirSync(SHOTS, { recursive: true })
    await page.screenshot({ path: path.join(SHOTS, `t159-${LABEL}-${name}.png`) })
}

function readConfig(userDataDir: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8'))
}

test.describe('T159 Getting started', () => {
    let ctx: LaunchResult | undefined
    let sandbox: Sandbox | undefined

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        if (sandbox) fs.rmSync(sandbox.root, { recursive: true, force: true })
        sandbox = undefined
    })

    test('first run: Continue → card; folder, Claude Code, first message tick it; it moves, then goes', async () => {
        test.setTimeout(180_000)
        sandbox = makeSandbox()
        ctx = await launchAppWithWorkspaces(
            [{ id: 'home', name: 'Home', path: sandbox.home, isHome: true, sessions: [] }],
            {
                // port 0: a free port, so a CLI Manager already running on the default one cannot get in the way
                settings: { hasCompletedOnboarding: false, controlApi: { enabled: false, port: 0, aiFolderName: 'AI Work' } },
                noTerminals: true,
                env: {
                    HOME: sandbox.home,
                    CLAUDE_CONFIG_DIR: sandbox.claudeDir,
                    CODEX_HOME: path.join(sandbox.root, 'codex-home'),
                    PATH: `${sandbox.bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
                    SHELL: '/bin/zsh',
                    CLIMANAGER_HOME: sandbox.climanagerHome,
                    CLIMANAGER_AGENT_CLI_FAKE: 'claude=installed,codex=missing,agy=installed'
                }
            }
        )
        const { page, app, userDataDir } = ctx
        const card = page.locator('[data-getting-started="full"]')
        const compact = page.locator('[data-getting-started="compact"]')

        // Welcome screen first; no card behind it
        const accept = page.getByRole('button', { name: /Accept and Continue/ })
        await expect(accept).toBeVisible({ timeout: 30_000 })
        await expect(card).toHaveCount(0)
        await shot(page, '0-welcome')
        await accept.click()

        await expect(card).toBeVisible()
        await expect(card.locator('[data-getting-started-count]')).toHaveText('0/4')
        await expect(card.locator('[data-getting-started-step="folder"]')).toHaveAttribute('data-done', 'false')
        await expect.poll(() => (readConfig(userDataDir).gettingStarted as { dismissed?: boolean } | undefined)?.dismissed).toBe(false)
        // the card replaces the frozen-terminal tip on the empty pane (review 2026-11-23)
        await expect(page.getByText('If the terminal seems frozen')).toHaveCount(0)
        await shot(page, '1-card-empty')

        // Step 1 — the card's Add folder… opens the same picker as the sidebar's +
        await app.evaluate(({ dialog }, dir) => {
            dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as unknown as typeof dialog.showOpenDialog
        }, sandbox.project)
        await card.locator('[data-getting-started-add-folder]').click()
        await expect(page.getByText('my-project').first()).toBeVisible()
        await expect(card.locator('[data-getting-started-count]')).toHaveText('1/4', { timeout: 10_000 })
        await expect(card.locator('[data-getting-started-step="folder"]')).toHaveAttribute('data-done', 'true')

        // The folder's + menu: Claude Code (installed) and Codex (missing → dim, still a button), above Plain Terminal
        await page.getByText('my-project').first().click({ button: 'right' })
        const claudeRow = page.locator('[data-builtin-template="claude"]')
        const codexRow = page.locator('[data-builtin-template="codex"]')
        await expect(claudeRow).toBeVisible()
        await expect(codexRow).toHaveAttribute('data-cli-status', 'missing')
        await expect(codexRow).toContainText('Not installed')
        await expect(codexRow).toHaveCSS('opacity', '0.5')
        await expect(claudeRow).toHaveAttribute('data-cli-status', 'installed')
        await expect(claudeRow).toHaveCSS('opacity', '1')
        await expect(claudeRow).toContainText('claude')
        // each row carries its program's logo, not a generic icon
        await expect(claudeRow.locator('svg[data-agent-logo="claude"]')).toBeVisible()
        await expect(codexRow.locator('svg[data-agent-logo="codex"]')).toBeVisible()
        // Antigravity (installed): its own mark, the `agy` command, normal opacity
        const agyRow = page.locator('[data-builtin-template="agy"]')
        await expect(agyRow).toHaveAttribute('data-cli-status', 'installed')
        await expect(agyRow).toHaveCSS('opacity', '1')
        await expect(agyRow).toContainText('Antigravity')
        await expect(agyRow).toContainText('agy')
        const agyLogo = agyRow.locator('svg[data-agent-logo="agy"]')
        await expect(agyLogo).toBeVisible()
        expect((await agyLogo.locator('path').getAttribute('d'))?.startsWith('M21.751 22.607')).toBe(true)
        const logoBox = await agyLogo.boundingBox()
        expect(logoBox!.width).toBeGreaterThan(8)
        const order = await page.evaluate(() => {
            const name = (b: Element): string => b.querySelector('span.truncate')?.textContent?.trim() ?? ''
            return Array.from(document.querySelectorAll('button')).map(name).filter((n) => /^(Claude Code|Codex|Antigravity|Plain Terminal)$/.test(n))
        })
        expect(order).toEqual(['Claude Code', 'Codex', 'Antigravity', 'Plain Terminal'])
        await shot(page, '2-plus-menu')

        // Step 2 — the Claude Code row starts `claude` (the stand-in) in a new session
        await claudeRow.click()
        await expect(compact).toBeVisible({ timeout: 30_000 })
        await expect(card).toHaveCount(0)
        await expect(compact.locator('[data-getting-started-count]')).toHaveText('2/4', { timeout: 30_000 })
        await expect(compact.locator('[data-getting-started-next]')).toHaveAttribute('data-getting-started-next', 'chat')
        // adding a folder also makes its plain "Main" session; the agent is the one opened from the row
        const agentSession = (): { id: string; templateId?: string } | undefined => {
            const workspaces = readConfig(userDataDir).workspaces as { path: string; sessions: { id: string; templateId?: string }[] }[]
            return workspaces.find((w) => w.path === sandbox!.project)?.sessions.find((x) => x.templateId === 'builtin-claude-code')
        }
        await expect.poll(() => agentSession()?.templateId).toBe('builtin-claude-code')
        await shot(page, '3-compact')

        // Step 3 — a first message reaches the agent and its transcript
        const sessionId = agentSession()!.id
        // only the stand-in may get the message: its own banner, never a real Claude's
        await expect.poll(() => termText(page, sessionId), { timeout: 30_000 }).toContain('Claude Code (mock)')
        await writeToTerminal(page, sessionId, 'hello from t159')
        await page.waitForTimeout(300)
        await writeToTerminal(page, sessionId, '\r')
        // three of four: the card stays, asking for the AI step, with its buttons right in the small card
        await expect(compact.locator('[data-getting-started-count]')).toHaveText('3/4', { timeout: 30_000 })
        await expect(compact.locator('[data-getting-started-next]')).toHaveAttribute('data-getting-started-next', 'ai')
        await expect(compact.locator('[data-getting-started-turn-on-api]')).toBeVisible()
        await expect(compact.locator('[data-getting-started-copy-install]')).toBeVisible()
        await expect(compact.locator('[data-getting-started-api-docs]')).toBeVisible()
        await shot(page, '4-compact-ai')

        // Step 4 — API on (the button) and the skill folder (a file in the temporary HOME) together tick it
        await compact.locator('[data-getting-started-turn-on-api]').click()
        await expect(compact.locator('[data-getting-started-ai-on]')).toBeVisible({ timeout: 15_000 })
        await expect(compact.locator('[data-getting-started-count]')).toHaveText('3/4') // the skill is still missing
        await expect(compact.locator('[data-getting-started-ai-status]')).toContainText('not found')
        const skillDir = path.join(sandbox.home, '.agents', 'skills', 'climanager-session')
        fs.mkdirSync(skillDir, { recursive: true })
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: climanager-session\n---\n')
        await expect(compact).toHaveCount(0, { timeout: 15_000 })
        await expect(card).toHaveCount(0)
        await expect.poll(() => readConfig(userDataDir).gettingStarted).toMatchObject({ dismissed: false, withAiStep: true, done: { folder: true, agent: true, chat: true, ai: true } })
        expect(JSON.stringify(readConfig(userDataDir).gettingStarted)).not.toContain('apiOn')
        await shot(page, '5-done')
        expect(ctx.pageErrors).toEqual([])
    })

    test('an existing user never sees the card; ✕ hides it for good and a replay brings it back', async () => {
        test.setTimeout(120_000)
        sandbox = makeSandbox()
        ctx = await launchAppWithWorkspaces(
            [{ id: 'p', name: 'proj', path: sandbox.project, sessions: [] }],
            { env: { CLIMANAGER_AGENT_CLI_FAKE: 'claude=installed,codex=installed' }, customTemplates: [{ id: 't1', name: 'My Claude', icon: 'code', description: '', command: 'claude --model opus' }] }
        )
        const { page, userDataDir } = ctx
        // hasCompletedOnboarding: true and no stored state → nothing
        await page.waitForTimeout(1500)
        await expect(page.locator('[data-getting-started]')).toHaveCount(0)

        // the person's own `claude …` template hides the built-in Claude row; Codex stays, normal
        // no checklist: the empty pane keeps its tip
        await expect(page.getByText('If the terminal seems frozen')).toBeVisible()
        await page.getByText('proj').first().click({ button: 'right' })
        await expect(page.locator('[data-builtin-template="claude"]')).toHaveCount(0)
        await expect(page.locator('[data-builtin-template="codex"]')).toHaveAttribute('data-cli-status', 'installed')
        await expect(page.getByRole('button', { name: 'My Claude' })).toBeVisible()
        await page.keyboard.press('Escape')

        // Settings › General › Onboarding → Continue → the card, with the folder already ticked
        await page.locator('button[title^="Settings"]').first().click()
        await page.getByRole('button', { name: 'Show Again' }).click()
        await page.getByRole('button', { name: /Accept and Continue/ }).click()
        const card = page.locator('[data-getting-started="full"]')
        await expect(card).toBeVisible({ timeout: 15_000 })
        await expect(card.locator('[data-getting-started-count]')).toHaveText('1/4', { timeout: 10_000 })

        await card.locator('[data-getting-started-dismiss]').click()
        await expect(page.locator('[data-getting-started]')).toHaveCount(0)
        await expect.poll(() => readConfig(userDataDir).gettingStarted).toMatchObject({ dismissed: true, done: { folder: true } })
        await page.waitForTimeout(3500)
        await expect(page.locator('[data-getting-started]')).toHaveCount(0)
    })

    test('a card finished before the AI step existed stays gone; «Show Again» adds the fourth step', async () => {
        test.setTimeout(120_000)
        sandbox = makeSandbox()
        ctx = await launchAppWithWorkspaces(
            [{ id: 'p', name: 'proj', path: sandbox.project, sessions: [] }],
            {
                env: { HOME: sandbox.home, CLIMANAGER_HOME: sandbox.climanagerHome, CLIMANAGER_AGENT_CLI_FAKE: 'claude=installed,codex=installed' },
                // the stored shape of a card from before the fourth step: three steps done, no `withAiStep`
                config: { gettingStarted: { startedAt: 1, dismissed: false, done: { folder: true, agent: true, chat: true }, alreadyDone: [] } }
            }
        )
        const { page, userDataDir } = ctx
        // finished before: no card on start, and no card after the timer has run a few times
        await page.waitForTimeout(4500)
        await expect(page.locator('[data-getting-started]')).toHaveCount(0)

        await page.locator('button[title^="Settings"]').first().click()
        await page.getByRole('button', { name: 'Show Again' }).click()
        await page.getByRole('button', { name: /Accept and Continue/ }).click()
        const card = page.locator('[data-getting-started="full"]')
        await expect(card).toBeVisible({ timeout: 15_000 })
        await expect(card.locator('[data-getting-started-count]')).toHaveText('3/4')
        await expect(card.locator('[data-getting-started-already]')).toHaveCount(3)
        await expect(card.locator('[data-getting-started-all-done]')).toHaveCount(0)
        await expect(card.locator('[data-getting-started-step="ai"]')).toHaveAttribute('data-done', 'false')
        await expect(card.locator('[data-getting-started-ai-warning]')).toContainText('127.0.0.1')
        await shot(page, '6-replay-legacy')

        await card.locator('[data-getting-started-dismiss]').click()
        await expect(page.locator('[data-getting-started]')).toHaveCount(0)
        await expect.poll(() => readConfig(userDataDir).gettingStarted).toMatchObject({ dismissed: true, withAiStep: true, alreadyDone: ['folder', 'agent', 'chat'] })
        expect(ctx.pageErrors).toEqual([])
    })

    test('a replay after all four were done says so, marks each step «Already done», and ✕ closes it', async () => {
        test.setTimeout(120_000)
        sandbox = makeSandbox()
        ctx = await launchAppWithWorkspaces(
            [{ id: 'p', name: 'proj', path: sandbox.project, sessions: [] }],
            {
                env: { HOME: sandbox.home, CLIMANAGER_HOME: sandbox.climanagerHome, CLIMANAGER_AGENT_CLI_FAKE: 'claude=installed,codex=installed' },
                config: { gettingStarted: { startedAt: 1, dismissed: false, done: { folder: true, agent: true, chat: true, ai: true }, alreadyDone: [], withAiStep: true } }
            }
        )
        const { page, userDataDir } = ctx
        await page.waitForTimeout(1500)
        await expect(page.locator('[data-getting-started]')).toHaveCount(0)

        await page.locator('button[title^="Settings"]').first().click()
        await page.getByRole('button', { name: 'Show Again' }).click()
        await page.getByRole('button', { name: /Accept and Continue/ }).click()
        const card = page.locator('[data-getting-started="full"]')
        await expect(card).toBeVisible({ timeout: 15_000 })
        await expect(card.locator('[data-getting-started-count]')).toHaveText('4/4')
        await expect(card.locator('[data-getting-started-all-done]')).toContainText('already done all four steps')
        await expect(card.locator('[data-getting-started-already]')).toHaveCount(4)
        await expect(page.getByText('If the terminal seems frozen')).toHaveCount(0)
        // still there after a check round
        await page.waitForTimeout(3500)
        await expect(card).toBeVisible()
        await shot(page, '7-replay-all-done')

        await card.locator('[data-getting-started-dismiss]').click()
        await expect(page.locator('[data-getting-started]')).toHaveCount(0)
        await expect.poll(() => readConfig(userDataDir).gettingStarted).toMatchObject({ dismissed: true, alreadyDone: ['folder', 'agent', 'chat', 'ai'] })
        expect(ctx.pageErrors).toEqual([])
    })

    test('«Show Again» when the API is already on and the skill is installed shows an all-done card (4/4)', async () => {
        test.setTimeout(120_000)
        sandbox = makeSandbox()
        // the person who connected an agent before this step existed: skill folder present, API on
        fs.mkdirSync(path.join(sandbox.home, '.claude', 'skills', 'climanager-session'), { recursive: true })
        fs.writeFileSync(path.join(sandbox.home, '.claude', 'skills', 'climanager-session', 'SKILL.md'), '---\nname: climanager-session\n---\n')
        ctx = await launchAppWithWorkspaces(
            [{ id: 'p', name: 'proj', path: sandbox.project, sessions: [] }],
            {
                settings: { controlApi: { enabled: true, port: 0, aiFolderName: 'AI Work' } },
                env: { HOME: sandbox.home, CLIMANAGER_HOME: sandbox.climanagerHome, CLIMANAGER_AGENT_CLI_FAKE: 'claude=installed,codex=installed' },
                config: { gettingStarted: { startedAt: 1, dismissed: false, done: { folder: true, agent: true, chat: true }, alreadyDone: [] } }
            }
        )
        const { page } = ctx
        await page.waitForTimeout(1500)
        await expect(page.locator('[data-getting-started]')).toHaveCount(0)
        await page.locator('button[title^="Settings"]').first().click()
        await page.getByRole('button', { name: 'Show Again' }).click()
        await page.getByRole('button', { name: /Accept and Continue/ }).click()
        const card = page.locator('[data-getting-started="full"]')
        await expect(card).toBeVisible({ timeout: 15_000 })
        await expect(card.locator('[data-getting-started-count]')).toHaveText('4/4')
        await expect(card.locator('[data-getting-started-all-done]')).toContainText('already done all four steps')
        await expect(card.locator('[data-getting-started-already]')).toHaveCount(4)
        await page.waitForTimeout(3500)
        await expect(card).toBeVisible()
        expect(ctx.pageErrors).toEqual([])
    })

    test('the AI step\'s buttons act: API on (real /v1/health), install command copied, docs opened; a finished step needs both', async () => {
        test.setTimeout(120_000)
        sandbox = makeSandbox()
        ctx = await launchAppWithWorkspaces(
            [{ id: 'p', name: 'proj', path: sandbox.project, sessions: [] }],
            {
                settings: { controlApi: { enabled: false, port: 0, aiFolderName: 'AI Work' } },
                env: { HOME: sandbox.home, CLIMANAGER_HOME: sandbox.climanagerHome, CLIMANAGER_AGENT_CLI_FAKE: 'claude=installed,codex=installed' },
                // the first three steps done in a four-step card: only the AI step is left
                config: { gettingStarted: { startedAt: 1, dismissed: false, done: { folder: true, agent: true, chat: true }, alreadyDone: [], withAiStep: true } }
            }
        )
        const { page, app, userDataDir } = ctx
        const card = page.locator('[data-getting-started="full"]')
        await expect(card).toBeVisible({ timeout: 15_000 })
        await expect(card.locator('[data-getting-started-count]')).toHaveText('3/4')
        const discoveryPath = path.join(sandbox.climanagerHome, 'control-api.json')
        // off until the person presses the button: no server, no discovery file, the warning says what it opens
        await expect(card.locator('[data-getting-started-ai-warning]')).toContainText('this Mac only')
        expect(fs.existsSync(discoveryPath)).toBe(false)
        await shot(page, '8-ai-step-full')

        // docs → the default browser (main's shell.openExternal, stubbed)
        await app.evaluate(({ shell }) => {
            const urls: string[] = []
            ;(globalThis as unknown as { __opened: string[] }).__opened = urls
            shell.openExternal = async (url: string) => { urls.push(url) }
        })
        await card.locator('[data-getting-started-api-docs]').click()
        await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened))
            .toEqual(['https://climanager.solhun.com/docs/ai-control-api'])

        // copy → the system clipboard (the machine's: put back what was there)
        const savedClipboard = await app.evaluate(({ clipboard }) => clipboard.readText())
        try {
            await card.locator('[data-getting-started-copy-install]').click()
            await expect(card.locator('[data-getting-started-copy-install]')).toContainText('Copied')
            expect(await app.evaluate(({ clipboard }) => clipboard.readText()))
                .toBe('npx skills add woorichicken/climanager-session@climanager-session -g')
        } finally {
            await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), savedClipboard)
        }

        // Turn on → the same saved key as Settings › Agents, and a server that really answers
        await card.locator('[data-getting-started-turn-on-api]').click()
        await expect(card.locator('[data-getting-started-ai-on]')).toBeVisible({ timeout: 15_000 })
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as { url: string; token: string }
        const health = await fetch(discovery.url + '/v1/health', { headers: { Authorization: `Bearer ${discovery.token}` } })
        expect(health.status).toBe(200)
        expect((readConfig(userDataDir).settings as { controlApi: { enabled: boolean; port: number } }).controlApi).toMatchObject({ enabled: true, port: 0 })
        // Settings › Agents agrees with the card's switch, and saving something unrelated there keeps the API on
        // (this window and the Settings window each save a whole copy of the settings)
        await page.locator('button[title^="Settings"]').first().click()
        await page.getByTestId('settings-category-agents').click()
        const agentsToggle = page.getByText('Enable AI Control API').locator('xpath=ancestor::div[contains(@class,"justify-between")][1]').locator('button')
        await expect(agentsToggle).toHaveClass(/bg-emerald-600/)
        await page.getByTestId('settings-category-sidebar').click()
        await page.getByTestId('settings-show-playground').click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect(page.getByText('PLAYGROUND', { exact: true })).toHaveCount(0, { timeout: 15_000 })
        expect((readConfig(userDataDir).settings as { controlApi: { enabled: boolean } }).controlApi.enabled).toBe(true)
        expect((await fetch(discovery.url + '/v1/health', { headers: { Authorization: `Bearer ${discovery.token}` } })).status).toBe(200)
        // the API alone does not tick the step: the skill folder is still missing
        await page.waitForTimeout(3500)
        await expect(card.locator('[data-getting-started-count]')).toHaveText('3/4')
        expect((readConfig(userDataDir).gettingStarted as { done: Record<string, boolean> }).done.ai).toBeUndefined()

        // the skill, as a symlink (installs often link into ~/.claude/skills), completes it
        const target = path.join(sandbox.root, 'skill-source')
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(path.join(target, 'SKILL.md'), '---\nname: climanager-session\n---\n')
        fs.mkdirSync(path.join(sandbox.home, '.claude', 'skills'), { recursive: true })
        fs.symlinkSync(target, path.join(sandbox.home, '.claude', 'skills', 'climanager-session'))
        await expect(page.locator('[data-getting-started]')).toHaveCount(0, { timeout: 15_000 })
        await expect.poll(() => readConfig(userDataDir).gettingStarted).toMatchObject({ done: { ai: true } })
        expect(ctx.pageErrors).toEqual([])
    })
})
