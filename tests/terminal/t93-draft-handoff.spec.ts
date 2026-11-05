import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T93 — the Terminal ↔ Chat switch carries what was being written (4b9cb0c2, people's decision 11-05).
 *
 *  - Mac (header button, ⌘⇧M): unsent Chat text → Claude's input box without Enter, the chat box empties;
 *    back to Chat, a one-row draft in the box → the chat box, the input box empties
 *  - text already in the box is never written over (notice); several rows stay in the terminal (notice)
 *  - Codex: nothing moves, the chat keeps its text and says so
 *  - phone (Chat | Terminal tabs): the same, against the Mac's terminal
 *
 * Sessions run chat-mock (Claude/Codex-shaped screens; Ctrl+U empties its box). T93_SHOTS + T93_LABEL
 * save captures before the checks.
 */

const CLAUDE = 't93-claude'
const CODEX = 't93-codex'
const OWNER = 'owner-t93@example.com'
const PORT = 47893
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const LABEL = process.env.T93_LABEL ?? 'run'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) {
        const done = result
        const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
        if (!closed) {
            done.app.process().kill('SIGKILL')
            fs.rmSync(done.userDataDir, { recursive: true, force: true })
        }
    }
    result = null
})

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
    const dir = process.env.T93_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), ...(clip ? { clip } : {}) })
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t93-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', 'x', '00000000-0000-4000-8000-00000000c93a.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, '')
    const rollout = path.join(home, 'codex', 'sessions', '2026', '11', '05', 'rollout-2026-11-05T10-00-00-00000000-0000-4000-8000-00000000c93b.jsonl')
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.writeFileSync(rollout, '')
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t93',
            name: 'T93 project',
            path: project,
            sessions: [
                { id: CLAUDE, name: 'T93 Claude', cliSessionId: '00000000-0000-4000-8000-00000000c93a', cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300` },
                { id: CODEX, name: 'T93 Codex', cliSessionId: '00000000-0000-4000-8000-00000000c93b', cliToolName: 'codex', cliCommand: `node ${MOCK} --agent codex --transcript ${rollout} --work-ms 300` }
            ]
        }],
        {
            settings: { phone: { enabled: true, port: PORT } },
            env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex') }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    const state = await page.evaluate(() => window.api.getPhoneState())
    return { app, page, base: `http://127.0.0.1:${state.port}` }
}

const terminalLines = (page: Page, id: string): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), id)
/** The mock's input row, as the mirror reads it. */
const boxRow = async (page: Page, id: string): Promise<string> => (await terminalLines(page, id)).split('\n').filter((line) => line.startsWith('❯')).pop() ?? ''

const macChat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function selectSession(page: Page, name: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await page.waitForTimeout(400)
}

test('T93 Mac: Chat → Terminal puts the unsent text in the box, Terminal → Chat brings a one-row draft back', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    await selectSession(page, 'T93 Claude')
    await page.getByTestId('view-toggle-chat').click()
    const composer = macChat(page).getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill('half a thought from chat')
    await shot(page, 't93-mac-1-chat', { x: 0, y: 0, width: 1280, height: 800 })

    // the header button
    await page.getByTestId('view-toggle-terminal').click()
    await expect.poll(() => boxRow(page, CLAUDE), { timeout: 10_000 }).toBe('❯ half a thought from chat')
    await shot(page, 't93-mac-2-terminal', { x: 0, y: 0, width: 1280, height: 800 })
    expect(await terminalLines(page, CLAUDE)).not.toContain('ANSWER[')
    // ⌘⇧M back: the one-row draft moves to the chat, the box empties
    await page.keyboard.press(`${MOD}+Shift+KeyM`)
    await expect(composer).toHaveValue('half a thought from chat', { timeout: 10_000 })
    await expect.poll(() => boxRow(page, CLAUDE), { timeout: 10_000 }).toBe('❯')
    await shot(page, 't93-mac-3-back', { x: 0, y: 0, width: 1280, height: 800 })
    // and over again with ⌘⇧M
    await page.keyboard.press(`${MOD}+Shift+KeyM`)
    await expect.poll(() => boxRow(page, CLAUDE), { timeout: 10_000 }).toBe('❯ half a thought from chat')
    await page.keyboard.press(`${MOD}+Shift+KeyM`)
    await expect(composer).toHaveValue('half a thought from chat', { timeout: 10_000 })
})

test('T93 Mac: never over text already in the box; several rows stay; Codex moves nothing', async () => {
    test.setTimeout(180_000)
    const { page } = await launch()
    await selectSession(page, 'T93 Claude')
    // someone at the Mac typed in the box, then opened Chat
    await writeToTerminal(page, CLAUDE, 'typed at the mac')
    await expect.poll(() => boxRow(page, CLAUDE)).toBe('❯ typed at the mac')
    await page.getByTestId('view-toggle-chat').click()
    const composer = macChat(page).getByTestId('chat-composer')
    // a one-row draft came along
    await expect(composer).toHaveValue('typed at the mac', { timeout: 10_000 })
    await expect.poll(() => boxRow(page, CLAUDE)).toBe('❯')
    // typed in the box again meanwhile: the chat text does not go over it
    await writeToTerminal(page, CLAUDE, 'newer at the mac')
    await expect.poll(() => boxRow(page, CLAUDE)).toBe('❯ newer at the mac')
    await page.getByTestId('view-toggle-terminal').click()
    const notice = page.getByTestId('draft-handoff-notice')
    await expect(notice).toContainText('already has text')
    await shot(page, 't93-mac-4-busy', { x: 0, y: 0, width: 1280, height: 800 })
    expect(await boxRow(page, CLAUDE)).toBe('❯ newer at the mac')
    await writeToTerminal(page, CLAUDE, '\x15')
    await expect.poll(() => boxRow(page, CLAUDE)).toBe('❯')
    await page.getByTestId('view-toggle-chat').click()
    await expect(composer).toHaveValue('typed at the mac')

    // several rows in the box: they stay, the chat is told
    await page.getByTestId('view-toggle-terminal').click()
    await expect.poll(() => boxRow(page, CLAUDE), { timeout: 10_000 }).toBe('❯ typed at the mac')
    await writeToTerminal(page, CLAUDE, '\x15')
    await writeToTerminal(page, CLAUDE, '\x1b[200~first line\nsecond line\x1b[201~')
    await expect.poll(async () => (await terminalLines(page, CLAUDE)).includes('second line')).toBe(true)
    await page.getByTestId('view-toggle-chat').click()
    await expect(notice).toContainText('more than one line')
    await expect(composer).toHaveValue('')
    expect(await terminalLines(page, CLAUDE)).toContain('❯ first line')
    await shot(page, 't93-mac-5-several', { x: 0, y: 0, width: 1280, height: 800 })

    // Codex: the chat keeps its text
    await selectSession(page, 'T93 Codex')
    await page.getByTestId('view-toggle-chat').click()
    const codex = macChat(page).getByTestId('chat-composer')
    await expect(codex).toBeVisible({ timeout: 15_000 })
    await codex.fill('codex draft')
    await page.getByTestId('view-toggle-terminal').click()
    await expect(notice).toContainText('Codex')
    expect(await terminalLines(page, CODEX)).not.toContain('codex draft')
    await page.getByTestId('view-toggle-chat').click()
    await expect(codex).toHaveValue('codex draft')
})

async function openPhone(app: ElectronApplication, url: string, partition: string): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, owner: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

async function tap(cdp: CDPSession, page: Page, testId: string): Promise<void> {
    const box = await page.getByTestId(testId).boundingBox()
    expect(box, testId).not.toBeNull()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('T93 phone: the Chat | Terminal tabs carry the draft both ways', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't93-phone')
    const composer = phone.getByTestId('chat-composer')
    await expect(composer).toBeVisible({ timeout: 15_000 })
    await composer.fill('written on the phone')
    await shot(phone, 't93-phone-1-chat')
    await tap(cdp, phone, 'phone-lens-terminal')
    await expect.poll(() => boxRow(page, CLAUDE), { timeout: 10_000 }).toBe('❯ written on the phone')
    await expect(phone.getByTestId('phone-terminal')).toBeVisible()
    await phone.waitForTimeout(800)
    await shot(phone, 't93-phone-2-terminal')
    expect(await terminalLines(page, CLAUDE)).not.toContain('ANSWER[')
    await tap(cdp, phone, 'phone-lens-chat')
    await expect(phone.getByTestId('chat-composer')).toHaveValue('written on the phone', { timeout: 10_000 })
    await expect.poll(() => boxRow(page, CLAUDE), { timeout: 10_000 }).toBe('❯')
    await shot(phone, 't93-phone-3-back')
})
