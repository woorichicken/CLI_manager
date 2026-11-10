import { test, expect, type ElectronApplication, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T125 — the background count opens its list (fb-1110 a0ba98c4 4회차, ovis BackgroundTasks): pressing
 * «1 shell · 1 agent» lists the background command and the subagent the transcript says run, with what
 * ended folded under «N recently ended»; the list reads again while open (a command's notification moves
 * it to ended), and the phone's chat shows the same list. The terminal shows a copied Claude screen (an
 * executable named «claude», as T122), drawn again when the test writes it. T125_SHOTS=<dir> + T125_LABEL
 * saves the Mac's and the phone's list.
 */

const SHOW = path.join(REPO_ROOT, 'tests/terminal/fixtures/show-screen.cjs')
const SESSION = 't125-claude'
const CONVERSATION = '00000000-0000-4000-8000-0000000c1250'
const OWNER = 'owner-t125@example.com'
const PORT = 47925
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const chat = (page: Page): Locator => page.locator('[data-testid="chat-view"][data-session-id]:visible')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result).catch(() => result?.app.process().kill('SIGKILL'))
    result = null
})

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const json = (value: unknown): string => `${JSON.stringify(value)}\n`

function seed(file: string, cwd: string): void {
    const base = { sessionId: CONVERSATION, cwd }
    const lines = [
        { type: 'user', timestamp: minutesAgo(10), message: { role: 'user', content: '테스트 돌리고 파서도 검토해 줘' } },
        // a background command still running, one that ended, and a background subagent
        { type: 'assistant', timestamp: minutesAgo(9), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_b1', name: 'Bash', input: { command: 'pnpm test', description: 'Run the test suite', run_in_background: true } }] } },
        { type: 'user', timestamp: minutesAgo(9), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b1', content: 'Command running in background with ID: b1.' }] }, toolUseResult: { backgroundTaskId: 'b1' } },
        { type: 'assistant', timestamp: minutesAgo(8), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_b2', name: 'Bash', input: { command: 'pnpm build', description: 'Build the app', run_in_background: true } }] } },
        { type: 'user', timestamp: minutesAgo(8), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_b2', content: 'Command running in background with ID: b2.' }] }, toolUseResult: { backgroundTaskId: 'b2' } },
        { type: 'assistant', timestamp: minutesAgo(7), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_a1', name: 'Agent', input: { description: 'Review the parser', subagent_type: 'reviewer', run_in_background: true } }] } },
        { type: 'user', timestamp: minutesAgo(7), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a1', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] }, toolUseResult: { status: 'async_launched' } },
        { type: 'user', timestamp: minutesAgo(5), message: { role: 'user', content: notice('b2', 'Background command "Build the app" completed (exit code 0)') } },
        { type: 'assistant', timestamp: minutesAgo(4), message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: '테스트와 검토를 뒤에서 돌리고 있습니다.' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }
    ]
    fs.writeFileSync(file, lines.map((line) => json({ ...base, ...line })).join(''))
    const agents = path.join(file.replace(/\.jsonl$/, ''), 'subagents')
    fs.mkdirSync(agents, { recursive: true })
    fs.writeFileSync(path.join(agents, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'reviewer', description: 'Review the parser', toolUseId: 'toolu_a1' }))
    fs.writeFileSync(path.join(agents, 'agent-a1.jsonl'), json({ isSidechain: true, sessionId: CONVERSATION, agentId: 'a1', type: 'user', timestamp: minutesAgo(7), message: { role: 'user', content: 'Review the parser' } }))
}

function notice(id: string, summary: string): string {
    return `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>completed</status>\n<summary>${summary}</summary>\n<result>ok</result>\n</task-notification>`
}

function screen(file: string, row: string): void {
    const rule = '─'.repeat(90)
    fs.writeFileSync(file, ['⏺ 테스트와 검토를 뒤에서 돌리고 있습니다.', '', rule, '❯ ', rule, '  ~/project | branch:main | Opus', `  ⏵⏵ bypass permissions on${row}`].join('\n'))
}

async function openPhone(app: ElectronApplication, url: string): Promise<Page> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition: 't125', owner: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    return phone
}

/** The rows of the open list: «kind status title», running first. */
async function rows(panel: Locator): Promise<string[]> {
    return panel.locator('[data-testid="chat-background-task"]:visible').evaluateAll((items) =>
        items.map((item) => `${item.getAttribute('data-kind')} ${item.getAttribute('data-status')} ${item.querySelector('.chat-bg-task-title')?.textContent?.trim()}`)
    )
}

test('T125 the background count opens what runs and what ended, on the Mac and on the phone', async () => {
    test.setTimeout(150_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t125-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const file = path.join(claudeDir, 'projects', slug(project), `${CONVERSATION}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    seed(file, project)
    const screenFile = path.join(home, 'screen.txt')
    screen(screenFile, ' · 1 shell · ← 1 agent')
    const bin = path.join(home, 'bin')
    fs.mkdirSync(bin)
    const claude = path.join(bin, 'claude')
    fs.writeFileSync(claude, `#!/bin/sh\nexec node '${SHOW}' '${screenFile}'\n`, { mode: 0o755 })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t125', name: 'T125 project', path: project, sessions: [{ id: SESSION, name: 'T125 Claude', cliSessionId: CONVERSATION, cliToolName: 'claude', cliCommand: `'${claude}'` }] }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLAUDE_CONFIG_DIR: claudeDir, CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await page.getByText('T125 Claude', { exact: true }).first().click()
    await waitForBufferText(page, SESSION, 'bypass permissions on', 20_000)
    await page.getByTestId('view-toggle-chat').click()
    const view = chat(page)
    const chip = view.getByTestId('chat-background-chip')
    await expect(chip).toHaveText('1 shell · 1 agent', { timeout: 15_000 })

    // pressed: what runs, oldest first; what ended is one folded line
    await chip.click()
    const panel = view.getByTestId('chat-background-panel')
    await expect(panel).toBeVisible()
    await expect.poll(() => rows(panel), { timeout: 10_000 }).toEqual(['shell running Run the test suite', 'agent running Review the parser'])
    await expect(panel.getByTestId('chat-background-task').filter({ hasText: 'Review the parser' })).toContainText('reviewer')
    await expect(panel.getByTestId('chat-background-task').filter({ hasText: 'Run the test suite' })).toContainText(/shell · \d+m \d+s/)
    const ended = panel.getByTestId('chat-background-ended-toggle')
    await expect(ended).toHaveText('1 recently ended')
    await ended.click()
    await expect.poll(() => rows(panel)).toEqual(['shell running Run the test suite', 'agent running Review the parser', 'shell completed Build the app'])
    if (process.env.T125_SHOTS) {
        fs.mkdirSync(process.env.T125_SHOTS, { recursive: true })
        await page.waitForTimeout(400)
        await page.screenshot({ path: path.join(process.env.T125_SHOTS, `t125-mac-${process.env.T125_LABEL ?? 'run'}.png`) })
    }

    // the test command ends: its notification moves it to ended while the list is open, and the count follows
    fs.appendFileSync(file, json({ sessionId: CONVERSATION, cwd: project, type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: notice('b1', 'Background command "Run the test suite" completed (exit code 0)') } }))
    screen(screenFile, ' · ← 1 agent')
    await expect(chip).toHaveText('1 agent', { timeout: 15_000 })
    await expect.poll(() => rows(panel), { timeout: 10_000 }).toEqual(['agent running Review the parser', 'shell completed Run the test suite', 'shell completed Build the app'])
    // Escape closes it; opened again it starts on what runs, the ended line folded
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
    await chip.click()
    await expect(view.getByTestId('chat-background-ended')).toBeHidden()
    await expect(view.getByTestId('chat-background-ended-toggle')).toHaveText('2 recently ended')
    await page.keyboard.press('Escape')

    // the phone's chat: the same chip, the same list
    const state = await page.evaluate(() => window.api.getPhoneState())
    const phone = await openPhone(app, `http://127.0.0.1:${state.port}/?session=${SESSION}&view=chat`)
    const phoneView = phone.getByTestId('chat-view')
    const phoneChip = phoneView.getByTestId('chat-background-chip')
    await expect(phoneChip).toHaveText('1 agent', { timeout: 20_000 })
    await phoneChip.click()
    const phonePanel = phoneView.getByTestId('chat-background-panel')
    await expect.poll(() => rows(phonePanel), { timeout: 10_000 }).toEqual(['agent running Review the parser'])
    await phonePanel.getByTestId('chat-background-ended-toggle').click()
    await expect.poll(() => rows(phonePanel)).toEqual(['agent running Review the parser', 'shell completed Run the test suite', 'shell completed Build the app'])
    // inside the phone's screen
    const box = await phonePanel.boundingBox()
    expect(box && box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box)).toBe(true)
    if (process.env.T125_SHOTS) {
        await phone.waitForTimeout(400)
        await phone.screenshot({ path: path.join(process.env.T125_SHOTS, `t125-phone-${process.env.T125_LABEL ?? 'run'}.png`) })
    }
})
