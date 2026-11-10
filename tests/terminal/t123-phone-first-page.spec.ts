import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T123 — the phone's chat reads a short first page (fb-1110 3회차, PHONE_CHAT_TURN_PAGE = 20 turns, about
 * ovis' ten prompts) and «Show earlier» reads the next page above it: every turn comes, once and in order,
 * and the line being read stays where it was. The Mac's chat of the same session still reads its 200.
 * T123_SHOTS=<dir> + T123_LABEL saves the phone's first page and the page after «Show earlier».
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const AGENT = 't123-claude'
const CONVERSATION = '00000000-0000-4000-8000-0000000c1230'
const OWNER = 'owner-t123@example.com'
const PORT = 47923
const PROMPTS = 45
const TURNS = PROMPTS * 2
const PAGE = 20
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')
const question = (n: number): string => `Question ${n}: please look at part ${n} of the plan.`
const answer = (n: number): string => `Answer ${n}: part ${n} is fine, nothing to change there.`

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) await closeApp(result).catch(() => result?.app.process().kill('SIGKILL'))
    result = null
})

function transcript(file: string, cwd: string): void {
    let counter = 0
    let parent: string | null = null
    const lines: string[] = []
    const record = (fields: Record<string, unknown>): void => {
        const uuid = `12300000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
        lines.push(JSON.stringify({ uuid, parentUuid: parent, timestamp: new Date(Date.UTC(2026, 10, 10, 1, 0, counter)).toISOString(), sessionId: 's', cwd, ...fields }))
        parent = uuid
    }
    const usage = { input_tokens: 1, output_tokens: 1 }
    for (let n = 0; n < PROMPTS; n++) {
        record({ type: 'user', message: { role: 'user', content: question(n) } })
        // a few lines each, so a page is taller than the phone's screen and the scroll position means something
        const text = [answer(n), '', ...Array.from({ length: 6 }, (_, row) => `- point ${row} of part ${n}`)].join('\n')
        record({ type: 'assistant', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', usage } })
    }
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
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
    }, { url, partition: 't123', owner: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    return phone
}

/** The words of every turn on screen, top to bottom (the first line of each). */
async function turnsOnScreen(view: ReturnType<Page['locator']>): Promise<string[]> {
    return view.locator('[data-testid="chat-turn"]').evaluateAll((turns) => turns.map((turn) => (turn.textContent ?? '').match(/(Question|Answer) \d+/)?.[0] ?? '?'))
}

test('T123 the phone reads 20 turns first; Show earlier brings every older turn, in order, in place', async () => {
    test.setTimeout(180_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t123-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const file = path.join(claudeDir, 'projects', slug(project), `${CONVERSATION}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    transcript(file, project)
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t123', name: 'T123 project', path: project, sessions: [{ id: AGENT, name: 'T123 Claude', cliSessionId: CONVERSATION, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${file} --continue` }] }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, AGENT, 'Claude Code (mock)', 30_000)
    const state = await page.evaluate(() => window.api.getPhoneState())
    const expected = Array.from({ length: PROMPTS }, (_, n) => [`Question ${n}`, `Answer ${n}`]).flat()

    const phone = await openPhone(app, `http://127.0.0.1:${state.port}/?session=${AGENT}&view=chat`)
    const asked: string[] = []
    phone.on('request', (request) => {
        if (/\/conversation(\?|$)/.test(request.url())) asked.push(new URL(request.url()).search)
    })
    const view = phone.getByTestId('chat-view')
    const turns = view.locator('[data-testid="chat-turn"]')
    const older = view.getByTestId('chat-older-note')
    const scroller = view.getByTestId('chat-scroll')

    // the first page: the newest 20 turns, asked for as 20
    await expect(turns).toHaveCount(PAGE, { timeout: 30_000 })
    await expect(older).toContainText(`Showing the last ${PAGE} of ${TURNS} turns.`)
    expect(await turnsOnScreen(view)).toEqual(expected.slice(-PAGE))
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((search) => search === `?limit=${PAGE}`), asked.join(' ')).toBe(true)

    // Show earlier, page by page, from the top of the chat: the turn that was first stays on the same line
    let shown = PAGE
    let pages = 0
    while (shown < TURNS) {
        await scroller.evaluate((element) => (element.scrollTop = 0))
        await phone.waitForTimeout(150)
        const first = await turnsOnScreen(view).then((list) => list[0])
        const firstTurn = view.locator('[data-testid="chat-turn"]', { hasText: `${first}:` }).first()
        if (pages === 0 && process.env.T123_SHOTS) {
            // the top of the first page: where «Show earlier» is
            fs.mkdirSync(process.env.T123_SHOTS, { recursive: true })
            await phone.screenshot({ path: path.join(process.env.T123_SHOTS, `t123-first-${process.env.T123_LABEL ?? 'run'}.png`) })
        }
        const before = await firstTurn.evaluate((element) => element.getBoundingClientRect().top - element.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect().top)
        await older.getByTestId('chat-show-earlier').click()
        shown = Math.min(TURNS, shown + PAGE)
        await expect(turns).toHaveCount(shown, { timeout: 10_000 })
        await phone.waitForTimeout(150)
        const after = await firstTurn.evaluate((element) => element.getBoundingClientRect().top - element.closest('[data-testid="chat-scroll"]')!.getBoundingClientRect().top)
        expect(Math.abs(after - before), `«${first}» stayed in place (${before} → ${after})`).toBeLessThanOrEqual(2)
        expect(await turnsOnScreen(view)).toEqual(expected.slice(-shown))
        if (pages++ === 0 && process.env.T123_SHOTS) {
            await phone.screenshot({ path: path.join(process.env.T123_SHOTS, `t123-earlier-${process.env.T123_LABEL ?? 'run'}.png`) })
        }
    }
    // all of it, once each and in order; nothing left to show
    expect(await turnsOnScreen(view)).toEqual(expected)
    await expect(older).toHaveCount(0)
    expect(asked).toContain(`?limit=${Math.ceil(TURNS / PAGE) * PAGE}`)

    // the Mac's chat of the same session reads as before: up to 200, so the whole conversation at once
    await page.getByText('T123 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    const mac = page.locator('[data-testid="chat-view"][data-session-id]:visible')
    await expect(mac.locator('[data-testid="chat-turn"]')).toHaveCount(TURNS, { timeout: 15_000 })
    await expect(mac.getByTestId('chat-older-note')).toHaveCount(0)
    expect(await turnsOnScreen(mac)).toEqual(expected)
})
