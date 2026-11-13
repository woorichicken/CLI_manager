import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T117 — Chat «Reply in thread» (chat-thread-1114).
 *
 * The parent session runs chat-mock on a seeded Claude transcript. The mock prints the arguments the app
 * typed after its saved command (`--show-args`) and writes what a fork is sent to its own file
 * (`--fresh-transcript`), so the parent's transcript stays as it was.
 *
 *  - Mac: one click opens Whole behind the parent without a dialog or first message. Anchored chips
 *    show one or several threads, navigate through the same session path, and disappear on close.
 *    Shift+click keeps the existing Whole / Excerpt / Quote dialog.
 *    Meanwhile the screen stays: the same session in front, the chat box keeps its draft and the focus.
 *  - Mac: Excerpt: the plain saved command, the first message = the turns up to that reply + the words.
 *  - phone: the same button and dialog over the phone page; the fork is made on the Mac.
 *  - AI (Control API): `POST /v1/sessions/:id/fork` and MCP `fork_session` — the latest reply by default, the new
 *    session marked AI-driven (an AI opened it), the MCP instructions say to fork when the user asks to split.
 *
 * T117_SHOTS=<dir> (+ T117_LABEL) saves captures at 1280 and 390, before the checks.
 */

const PARENT = 't117-parent'
const SHELL = 't117-shell'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000f117'
const OWNER = 'owner-t117@example.com'
const PORT = 47917
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const LABEL = process.env.T117_LABEL ?? 'run'
function lastReplyTs(): string {
    const records = fs.readFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    // This fixture has one answer turn: thinking, tools and the final text share its first timestamp.
    return records.find((record) => record.type === 'assistant')!.timestamp
}
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

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

async function shot(page: Page, name: string, width = 1280, height = 800): Promise<void> {
    const dir = process.env.T117_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`), clip: { x: 0, y: 0, width, height } })
}

interface Launched {
    app: ElectronApplication
    page: Page
    base: string
    project: string
    fresh: string
    transcript: string
    home: string
}

async function launch(): Promise<Launched> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t117-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    const fresh = path.join(home, 'fork-records.jsonl')
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t117',
                name: 'T117 project',
                path: project,
                sessions: [
                    { id: PARENT, name: 'T117 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --fresh-transcript ${fresh} --show-args --work-ms 400` },
                    { id: SHELL, name: 'T117 Shell' }
                ]
            }
        ],
        {
            settings: { phone: { enabled: true, port: PORT }, controlApi: { enabled: true, port: 0 } },
            env: { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLIMANAGER_HOME: path.join(home, 'clim') }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, PARENT, 'Claude Code (mock)', 20_000)
    const state = await page.evaluate(() => window.api.getPhoneState())
    return { app, page, base: `http://127.0.0.1:${state.port}`, project, fresh, transcript, home }
}

interface StoredSession {
    id: string
    name: string
    cwd?: string
    initialCommand?: string
    cliToolName?: string
    cliCommand?: string
    aiControl?: unknown
}
function readConfig(): { workspaces: { id: string; sessions: StoredSession[] }[]; sessionRelations?: { from: string; to: string; kind: string; anchor?: { turnTs: string; turnIndex?: number } }[] } {
    return JSON.parse(fs.readFileSync(path.join(result!.userDataDir, 'config.json'), 'utf8'))
}
const forks = (): StoredSession[] => readConfig().workspaces.flatMap((w) => w.sessions).filter((s) => s.name.endsWith(' · fork'))

const terminalLines = (page: Page, id: string): Promise<string> =>
    page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId).then((c) => (c.terminal?.recentLines ?? []).join('\n')), id)
/** The prompts the forked mocks were sent, as they recorded them. */
function freshPrompts(file: string): string[] {
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((entry) => entry.type === 'user' && typeof entry.message?.content === 'string')
        .map((entry) => entry.message.content as string)
}

/** The sessions whose terminal or chat is on screen — what the person sees, not React state (T26). */
const visibleSessions = (page: Page): Promise<string[]> =>
    page.evaluate(() => Array.from(document.querySelectorAll('[data-session-id]')).filter((el) => getComputedStyle(el).visibility === 'visible').map((el) => el.getAttribute('data-session-id') ?? ''))

const macChat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')

async function selectSession(page: Page, name: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await page.waitForTimeout(400)
}

/** The last answer of the seeded transcript, in the Mac's chat, ready. */
async function openParentChat(page: Page) {
    await selectSession(page, 'T117 Claude')
    await page.getByTestId('view-toggle-chat').click()
    const view = macChat(page)
    await expect(view.locator('[data-testid="chat-turn"][data-role="assistant"]').last()).toBeVisible({ timeout: 15_000 })
    return view
}

test('T117 Mac: one click opens a thread behind this reply; chips navigate and track closure', async () => {
    test.setTimeout(180_000)
    const { app, page, fresh, transcript, project } = await launch()
    const view = await openParentChat(page)
    const parentBefore = fs.readFileSync(transcript, 'utf8')
    const composer = view.getByTestId('chat-composer')
    await composer.fill('a draft I keep')
    await composer.focus()
    await shot(page, 't117-1-chat')

    const reply = view.locator('[data-testid="chat-turn"][data-role="assistant"]').last()
    await reply.hover()
    await shot(page, 't117-1b-hover')
    const fork = reply.getByTestId('chat-fork')
    await fork.click()
    await expect(page.getByTestId('chat-fork-dialog')).toHaveCount(0)
    await expect(fork).toHaveAttribute('title', 'Reply in thread (Shift+click for options)')

    // the screen stays: same session, the draft and the focus where they were
    await expect(composer).toBeFocused()
    await expect(composer).toHaveValue('a draft I keep')
    await expect(macChat(page)).toHaveAttribute('data-session-id', PARENT)

    const notice = page.getByTestId('chat-fork-notice')
    await expect(notice).toHaveAttribute('data-state', 'forked', { timeout: 90_000 })
    await expect(notice).toContainText('T117 Claude · fork')
    await shot(page, 't117-3-forked')
    await expect(macChat(page)).toHaveAttribute('data-session-id', PARENT)
    await expect(composer).toHaveValue('a draft I keep')

    // the new session: same workspace and folder, the person's start command, a child in Related, no AI mark
    const [child] = forks()
    expect(child).toBeTruthy()
    expect(readConfig().workspaces.find((w) => w.id === 'w-t117')!.sessions.map((s) => s.id)).toContain(child.id)
    expect(child.cwd).toBe(project)
    expect(child.cliToolName).toBe('claude')
    expect(child.aiControl).toBeUndefined()
    expect(child.initialCommand).toBe(`${child.cliCommand} --resume ${CLAUDE_ID} --fork-session`)
    expect(readConfig().sessionRelations).toContainEqual(expect.objectContaining({ from: PARENT, to: child.id, kind: 'opened' }))
    await expect(page.getByText('T117 Claude · fork', { exact: true }).first()).toBeVisible()

    // Whole starts the agent's own fork and sends no first message.
    await expect.poll(() => terminalLines(page, child.id), { timeout: 30_000 }).toContain(`ARGS: --resume ${CLAUDE_ID} --fork-session`)
    expect(freshPrompts(fresh)).toEqual([])
    expect(await terminalLines(page, child.id)).not.toContain('ANSWER[')
    // the parent's own conversation and terminal were not touched
    expect(fs.readFileSync(transcript, 'utf8')).toBe(parentBefore)
    expect(await terminalLines(page, PARENT)).not.toContain('ANSWER[')

    const anchor = readConfig().sessionRelations!.find((relation) => relation.from === PARENT && relation.to === child.id)!.anchor!
    expect(anchor).toEqual({ turnTs: lastReplyTs(), turnIndex: Number(await reply.getAttribute('data-turn-index')) })
    const chip = reply.getByTestId('chat-thread-chip')
    await expect(chip).toContainText('1 thread')
    await expect(chip).toContainText(/ago|now/)
    await shot(page, 't117-2-one-thread')

    // Show and a single-thread chip both navigate to the child.
    await notice.getByTestId('chat-fork-show').click()
    await expect.poll(() => visibleSessions(page)).toContain(child.id)
    expect(await visibleSessions(page)).not.toContain(PARENT)
    await selectSession(page, 'T117 Claude')
    await chip.click()
    await expect.poll(() => visibleSessions(page)).toContain(child.id)
    await selectSession(page, 'T117 Claude')

    // A second thread stays under the same reply and opens a choice of children.
    await reply.hover()
    await fork.click()
    await expect.poll(() => forks().length).toBe(2)
    await expect(chip).toContainText('2 threads')
    const second = forks().find((session) => session.id !== child.id)!
    await expect.poll(() => terminalLines(page, second.id), { timeout: 30_000 }).toContain(`ARGS: --resume ${CLAUDE_ID} --fork-session`)
    expect(freshPrompts(fresh)).toEqual([])
    // A child changing state refreshes its parent's chip, even with sidebar status dots disabled.
    await page.evaluate((id) => window.api.writeTerminal(id, 'ASK\r'), child.id)
    await expect(chip).toContainText('waiting for you', { timeout: 15_000 })
    await chip.click()
    const list = page.getByTestId('chat-thread-list')
    await expect(list).toBeVisible()
    await expect(list.getByTestId('chat-thread-session')).toHaveCount(2)
    for (const row of await list.getByTestId('chat-thread-session').all()) {
        await expect(row).toContainText('T117 Claude · fork')
        await expect(row).toContainText(/working|waiting|idle/i)
        await expect(row).toContainText(/ago|now/)
        const textOffsets = await row.evaluate((element) => {
            const left = element.getBoundingClientRect().left
            return Array.from(element.querySelectorAll('.chat-thread-name, .chat-menu-note')).map((text) => {
                const range = document.createRange()
                range.selectNodeContents(text)
                return range.getBoundingClientRect().left - left
            })
        })
        expect(textOffsets).toHaveLength(2)
        for (const offset of textOffsets) {
            expect(offset).toBeGreaterThanOrEqual(0)
            expect(offset).toBeLessThanOrEqual(12)
        }
    }
    // The opening notice must not cover even the bottom-right edge of the last choice.
    const lastChoice = list.getByTestId('chat-thread-session').last()
    const choiceBox = await lastChoice.boundingBox()
    const choiceOnTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-child-id]')?.getAttribute('data-child-id'), { x: choiceBox!.x + choiceBox!.width - 4, y: choiceBox!.y + choiceBox!.height - 4 })
    expect(choiceOnTop).toBe(await lastChoice.getAttribute('data-child-id'))
    await shot(page, 't117-3-thread-list')
    await list.locator(`[data-child-id="${second.id}"]`).click()
    await expect.poll(() => visibleSessions(page)).toContain(second.id)
    await selectSession(page, 'T117 Claude')

    // The chip and its list stay inside a 390px window.
    await resizeMainWindow(app, 390, 800)
    const sidebar = page.locator('[title^="Close Sidebar"]').first()
    if (await sidebar.isVisible().catch(() => false)) await sidebar.evaluate((element) => (element as HTMLElement).click())
    await chip.scrollIntoViewIfNeeded()
    const chipBox = await chip.boundingBox()
    expect(chipBox!.x).toBeGreaterThanOrEqual(0)
    expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(390)
    await chip.click()
    const listBox = await list.boundingBox()
    expect(listBox!.x).toBeGreaterThanOrEqual(0)
    expect(listBox!.x + listBox!.width).toBeLessThanOrEqual(390)
    await shot(page, 't117-3b-thread-list-390', 390)
    await page.keyboard.press('Escape')

    // Closing children removes the chips through the app's session-close path.
    await page.evaluate((id) => window.api.removeSession('w-t117', id), child.id)
    await expect(chip).toContainText('1 thread')
    await page.evaluate((id) => window.api.removeSession('w-t117', id), second.id)
    await expect(reply.getByTestId('chat-thread-chip')).toHaveCount(0)
    expect(readConfig().sessionRelations?.filter((relation) => relation.from === PARENT)).toEqual([])
})

test('T117 Mac: Excerpt — a new agent whose first message is the turns up to that reply, then the words; Esc cancels', async () => {
    test.setTimeout(180_000)
    const { page, fresh } = await launch()
    const view = await openParentChat(page)
    const reply = view.locator('[data-testid="chat-turn"][data-role="assistant"]').last()

    // Esc cancels: nothing is opened
    await reply.hover()
    await reply.getByTestId('chat-fork').click({ modifiers: ['Shift'] })
    await expect(page.getByTestId('chat-fork-dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('chat-fork-dialog')).toHaveCount(0)
    expect(forks()).toEqual([])

    await reply.hover()
    await reply.getByTestId('chat-fork').click({ modifiers: ['Shift'] })
    const dialog = page.getByTestId('chat-fork-dialog')
    await dialog.getByTestId('chat-fork-scope-excerpt').click()
    await expect(dialog.getByTestId('chat-fork-quote').locator('input')).toBeDisabled()
    await dialog.getByTestId('chat-fork-message').fill('Only the guard, in its own branch.')
    await shot(page, 't117-4-excerpt')
    await dialog.getByTestId('chat-fork-submit').click()
    await expect(page.getByTestId('chat-fork-notice')).toHaveAttribute('data-state', 'forked', { timeout: 90_000 })

    const [child] = forks()
    // the plain saved command: no resume, no fork
    expect(child.initialCommand).toBe(child.cliCommand)
    await expect.poll(() => terminalLines(page, child.id), { timeout: 30_000 }).toContain('ARGS: (none)')
    await expect.poll(() => freshPrompts(fresh).length, { timeout: 30_000 }).toBe(1)
    const [sent] = freshPrompts(fresh)
    // the seeded conversation's words, the final answer (not its tool calls), then the person's words
    expect(sent).toContain('T117 Claude')
    expect(sent).toContain('### Me')
    expect(sent).toContain('Add a guard to src/a.ts')
    expect(sent).not.toContain('"file_path"')
    expect(sent.trim().endsWith('Only the guard, in its own branch.')).toBe(true)
    expect(readConfig().sessionRelations).toContainEqual(expect.objectContaining({ from: PARENT, to: child.id, kind: 'opened' }))

    // 390 wide: the dialog fits
    await resizeMainWindow(result!.app, 390, 800)
    await page.waitForTimeout(600)
    const close = page.locator('[title^="Close Sidebar"]').first()
    if (await close.isVisible().catch(() => false)) await close.evaluate((element) => (element as HTMLElement).click())
    await page.waitForTimeout(400)
    await reply.hover()
    await reply.getByTestId('chat-fork').click({ modifiers: ['Shift'] })
    const narrow = page.getByTestId('chat-fork-dialog').locator('[role="dialog"]')
    const box = await narrow.boundingBox()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(390)
    await shot(page, 't117-5-dialog', 390)
    // the earlier fork's notice is still up: it must not cover the dialog's buttons
    const submit = await page.getByTestId('chat-fork-submit').boundingBox()
    const onTop = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid]')?.getAttribute('data-testid'), { x: submit!.x + submit!.width / 2, y: submit!.y + submit!.height / 2 })
    expect(onTop).toBe('chat-fork-submit')
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

async function tap(cdp: CDPSession, page: Page, locator: ReturnType<Page['locator']>): Promise<void> {
    const box = await locator.boundingBox()
    expect(box).not.toBeNull()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('T117 phone: the same Fork button and dialog; the new session is made on the Mac', async () => {
    test.setTimeout(180_000)
    const { app, page, base, fresh } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${PARENT}&view=chat`, 't117-phone')
    const reply = phone.locator('[data-testid="chat-turn"][data-role="assistant"]').last()
    await expect(reply).toBeVisible({ timeout: 20_000 })
    await shot(phone, 't117-6a-phone-chat', 390, 844)
    // no hover on a touch screen: the icon is there to tap
    await tap(cdp, phone, reply.getByTestId('chat-fork'))
    const dialog = phone.getByTestId('chat-fork-dialog')
    await expect(dialog).toBeVisible()
    // a touch screen does not open its keyboard by itself
    await expect(dialog.getByTestId('chat-fork-message')).not.toBeFocused()
    await dialog.getByTestId('chat-fork-message').fill('From the phone')
    await shot(phone, 't117-6-phone-dialog', 390, 844)
    await tap(cdp, phone, dialog.getByTestId('chat-fork-submit'))
    await expect(phone.getByTestId('chat-fork-notice')).toHaveAttribute('data-state', 'forked', { timeout: 90_000 })
    await shot(phone, 't117-7-phone-forked', 390, 844)
    const [child] = forks()
    expect(child.initialCommand).toBe(`${child.cliCommand} --resume ${CLAUDE_ID} --fork-session`)
    expect(readConfig().sessionRelations).toContainEqual(expect.objectContaining({ from: PARENT, to: child.id, kind: 'opened' }))
    await expect.poll(() => freshPrompts(fresh), { timeout: 30_000 }).toEqual(['From the phone'])
    // the Mac's screen did not move to the new session
    expect(await visibleSessions(page)).not.toContain(child.id)
})

test('T117 API: REST and MCP fork — the latest reply by default, an AI mark on the new session, refusals', async () => {
    test.setTimeout(180_000)
    const { page, fresh, home } = await launch()
    const view = await openParentChat(page)
    const reply = view.locator('[data-testid="chat-turn"][data-role="assistant"]').last()
    const discoveryPath = path.join(home, 'clim', 'control-api.json')
    await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
    const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf8')) as { url: string; mcpUrl: string; token: string }
    const api = async (route: string, body: unknown, caller?: string): Promise<{ status: number; json: any }> => {
        const res = await fetch(discovery.url + route, {
            method: 'POST',
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't117', ...(caller ? { 'X-Caller-Session': caller } : {}) },
            body: JSON.stringify(body)
        })
        const text = await res.text()
        return { status: res.status, json: text ? JSON.parse(text) : null }
    }
    const rpc = async (method: string, params: unknown): Promise<any> => {
        const res = await fetch(discovery.mcpUrl, {
            method: 'POST',
            headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Client-Name': 't117-mcp' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        })
        return JSON.parse(await res.text()).result
    }

    // the agent in the parent asks to split itself: the latest reply, whole conversation
    const rest = await api(`/v1/sessions/${PARENT}/fork`, { message: 'API branch: only the docs' }, PARENT)
    expect(rest.status).toBe(201)
    expect(rest.json.session.name).toBe('T117 Claude · fork')
    expect(rest.json.scope).toBe('whole')
    expect(rest.json.messageSent).toBe(true)
    const first = forks().find((s) => s.id === rest.json.session.id)!
    expect(first.initialCommand).toBe(`${first.cliCommand} --resume ${CLAUDE_ID} --fork-session`)
    // an AI opened it: marked like a session open_session made
    expect(first.aiControl).toMatchObject({ client: 't117' })
    expect(readConfig().sessionRelations).toContainEqual(expect.objectContaining({ from: PARENT, to: first.id, kind: 'opened' }))
    await expect.poll(() => terminalLines(page, first.id), { timeout: 30_000 }).toContain(`ARGS: --resume ${CLAUDE_ID} --fork-session`)
    await expect.poll(() => freshPrompts(fresh), { timeout: 30_000 }).toEqual(['API branch: only the docs'])

    await expect(reply.getByTestId('chat-thread-chip')).toContainText('1 thread')
    expect(readConfig().sessionRelations!.find((relation) => relation.to === first.id)!.anchor?.turnTs).toBe(lastReplyTs())

    // MCP: the tool is listed, the instructions say when to use it, an excerpt fork goes through
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't117', version: '1' } })
    expect(init.instructions).toContain('fork_session')
    const tools = await rpc('tools/list', {})
    const tool = tools.tools.find((t: { name: string }) => t.name === 'fork_session')
    expect(tool).toBeTruthy()
    expect(tool.description).toMatch(/split|fork/i)
    const mcp = await rpc('tools/call', { name: 'fork_session', arguments: { session_id: PARENT, scope: 'excerpt', message: 'MCP branch' } })
    expect(mcp.isError).toBeFalsy()
    const forked = JSON.parse(mcp.content[0].text)
    expect(forked.scope).toBe('excerpt')
    await expect.poll(() => freshPrompts(fresh).length, { timeout: 30_000 }).toBe(2)
    const excerpt = freshPrompts(fresh)[1]
    expect(excerpt).toContain('Add a guard to src/a.ts')
    expect(excerpt.trim().endsWith('MCP branch')).toBe(true)

    // refusals: a bad scope, an unknown session, a session with no agent conversation, a turn that is not a reply
    expect((await api(`/v1/sessions/${PARENT}/fork`, { scope: 'half' })).status).toBe(400)
    expect((await api('/v1/sessions/no-such-session/fork', {})).status).toBe(404)
    const shell = await api(`/v1/sessions/${SHELL}/fork`, {})
    expect(shell.status).toBe(409)
    expect(shell.json.error.code).toBe('no_conversation')
    expect((await api(`/v1/sessions/${PARENT}/fork`, { turnIndex: 0 })).status).toBe(409)
    expect(forks()).toHaveLength(2)
    await expect(reply.getByTestId('chat-thread-chip')).toContainText('2 threads')
    expect(readConfig().sessionRelations!.filter((relation) => relation.from === PARENT).map((relation) => relation.anchor?.turnTs)).toEqual([lastReplyTs(), lastReplyTs()])
})
