import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, termText, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T76 — the phone connection end to end: the app (Electron) and a phone (Chromium at
 * 390×844, touch) talking to the phone server.
 *
 * Tailscale is faked: CLIMANAGER_PHONE_TAILSCALE_STATUS names a status JSON (owner
 * owner@example.com, MagicDNS mac.tail1234.ts.net) — this Mac's Tailscale is never asked.
 * `tailscale serve` is played by request headers: Tailscale-User-Login + a tailnet
 * X-Forwarded-For. Alerts go to CLIMANAGER_PHONE_PUSH_LOG instead of a push service.
 *
 * Checked: off by default (nothing listens) → Settings › Phone on (serve command, QR,
 * sidebar badge) · access (owner in, no header / another login 401, Funnel 403, bad Host
 * 421, cross-origin POST 403, /v1 and /mcp do not exist, only phone assets served) ·
 * pairing on the phone with the Mac's code · the list in the Mac's All sessions order (row
 * for row with the sidebar's DOM, also after the order moves) with status dots · Chat (the desktop Chat view, sending typed into the Mac's
 * terminal, logged as from the phone) · question card answered from the phone · Terminal
 * at the Mac's size with the key bar and input line · a resize message refused · the Mac's
 * pty size unchanged and no `resized` event after the phone attached and left · view-only
 * device cannot type · alerts (question, once a minute, not while the Mac is in use, test)
 * and the alert's address opening that session's chat · revoke · off cuts the phone off.
 * PHONE_SHOTS=<folder> saves the review captures.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(__dirname, 'fixtures/transcripts')
const CLAUDE_ID = '00000000-0000-4000-8000-00000000c76a'
const CLAUDE2_ID = '00000000-0000-4000-8000-00000000c76b'
const CLAUDE = 't76-claude'
const CLAUDE2 = 't76-claude-2'
const SHELL = 't76-shell'
const OWNER = 'owner@example.com'
const SERVE = { 'Tailscale-User-Login': OWNER, 'X-Forwarded-For': '100.101.102.103' }
const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (result) {
        const done = result
        // a hidden phone window must not keep the app from quitting the test
        const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
        if (!closed) {
            done.app.process().kill('SIGKILL')
            fs.rmSync(done.userDataDir, { recursive: true, force: true })
        }
    }
    result = null
})

/** Where the run is, in the list reporter's output — a stuck step names itself. */
const mark = (step: string): void => console.log(`[t76] ${new Date().toISOString().slice(11, 19)} ${step}`)

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.PHONE_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, name) })
}

async function appShot(page: Page, name: string): Promise<void> {
    const dir = process.env.PHONE_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, name), clip: { x: 0, y: 0, width: 1280, height: 800 } })
}

const pushLines = (file: string): Array<{ payload: { title: string; body: string; url: string } }> =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []

async function ptyState(page: Page, id: string): Promise<{ size: { cols: number; rows: number } | null; resized: number; phoneInputs: string[] }> {
    const context = await page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId), id)
    const events = context.terminal?.events ?? []
    return {
        size: context.terminal?.size ?? null,
        resized: events.filter((e) => e.kind === 'resized').length,
        phoneInputs: events.filter((e) => e.kind === 'phone-input').map((e) => e.detail ?? '')
    }
}

test('T76 phone: off by default, access, pairing, list, Chat, card, Terminal + key bar, no resize, alerts, off', async () => {
    test.setTimeout(240_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t76-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const claudeDir = path.join(home, 'claude')
    const transcript = path.join(claudeDir, 'projects', claudeProjectSlug(project), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.copyFileSync(path.join(FIXTURES, 'claude/tools.jsonl'), transcript)
    const transcript2 = path.join(path.dirname(transcript), `${CLAUDE2_ID}.jsonl`)
    fs.writeFileSync(transcript2, '')
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({
        BackendState: 'Running',
        Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] },
        User: { '42': { LoginName: OWNER } }
    }))
    const pushLog = path.join(home, 'push.log')

    result = await launchAppWithWorkspaces(
        [
            {
                id: 'w-t76',
                name: 'T76 project',
                path: project,
                folderId: 'f-work',
                sessions: [
                    { id: CLAUDE, name: 'T76 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 1500`, sessionFolderId: 'sf-agents' },
                    { id: SHELL, name: 'T76 Shell', isPinned: true }
                ]
            },
            {
                id: 'w-t76b',
                name: 'T76 second',
                path: project,
                sessions: [
                    { id: CLAUDE2, name: 'T76 Claude 2', cliSessionId: CLAUDE2_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript2} --work-ms 800`, sessionFolderId: 'sf-agents' }
                ]
            }
        ],
        {
            folders: [{ id: 'f-work', name: 'Work', isExpanded: true, createdAt: 1 }],
            config: { sessionFolders: [{ id: 'sf-agents', name: 'Agents', isExpanded: true, createdAt: 1 }] },
            settings: { phone: { enabled: false, port: 0 } },
            env: {
                CLAUDE_CONFIG_DIR: claudeDir,
                CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile,
                CLIMANAGER_PHONE_PUSH_LOG: pushLog,
                CLIMANAGER_PHONE_FINISH_MIN_MS: '500'
            }
        }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)

    // --- off by default: nothing listens, no badge ---
    mark('off by default: nothing listens, no badge')
    const off = await page.evaluate(() => window.api.getPhoneState())
    expect(off.running).toBe(false)
    expect(off.port).toBeNull()
    await expect(page.getByTestId('phone-badge')).toHaveCount(0)

    // --- Settings › Phone: one switch ---
    mark('Settings › Phone: one switch')
    await page.locator('[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-phone').click()
    await expect(page.getByTestId('phone-settings')).toBeVisible()
    await appShot(page, 'settings-off-1280.png')
    await page.getByTestId('phone-toggle').click()
    await expect(page.getByTestId('phone-listening')).toBeVisible({ timeout: 10_000 })
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    const port = state.port!
    expect(port).toBeGreaterThan(0)
    const base = `http://127.0.0.1:${port}`
    await expect(page.getByTestId('phone-serve-command')).toHaveText(`tailscale serve --bg --https=443 http://127.0.0.1:${port}`)
    await expect(page.getByTestId('phone-serve-off-command')).toHaveText('tailscale serve --https=443 off')
    await expect(page.getByTestId('phone-url')).toHaveText('https://mac.tail1234.ts.net/')
    await expect(page.getByTestId('phone-qr')).toBeVisible()
    await expect(page.getByTestId('phone-owner')).toContainText(OWNER)
    await expect(page.getByTestId('phone-badge')).toContainText('Phone on · 0 connected')
    await appShot(page, 'settings-on-1280.png')

    // --- access over HTTP ---
    mark('access over HTTP')
    const get = (route: string, headers: Record<string, string> = {}) => fetch(`${base}${route}`, { headers })
    expect((await get('/api/phone/sessions')).status).toBe(401)
    expect((await get('/api/phone/sessions', { ...SERVE, 'Tailscale-User-Login': 'friend@example.com' })).status).toBe(401)
    expect((await get('/api/phone/sessions', { 'Tailscale-User-Login': OWNER })).status).toBe(401)
    expect((await get('/api/phone/sessions', { ...SERVE, 'Tailscale-Funnel-Request': '?1' })).status).toBe(403)
    // fetch cannot set Host: a raw request plays a page whose DNS points at 127.0.0.1
    expect(await rawStatus(port, '/api/phone/sessions', { ...SERVE, Host: 'evil.example' })).toBe(421)
    expect(await rawStatus(port, '/', { Host: 'evil.example' })).toBe(421)
    const owner = await get('/api/phone/sessions', SERVE)
    expect(owner.status).toBe(200)
    const list = (await owner.json()) as { sessions: Array<{ id: string; agent: string | null; workspaceId: string }>; folders: unknown[]; sessionFolders: unknown[] }
    // (the app adds its Home workspace and a session of its own)
    expect(list.sessions.map((s) => s.id)).toEqual(expect.arrayContaining([CLAUDE, CLAUDE2, SHELL]))
    expect(list.sessions.find((s) => s.id === CLAUDE)?.agent).toBe('claude')
    expect(list.sessions.find((s) => s.id === SHELL)?.agent).toBeNull()
    const crossSite = await fetch(`${base}/api/phone/chat/${SHELL}/send`, { method: 'POST', headers: { ...SERVE, Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"text":"x"}' })
    expect(crossSite.status).toBe(403)
    // the Control API does not live here, and no route makes, deletes or renames a session
    for (const route of ['/v1/sessions', '/mcp', '/api/phone/sessions/new', `/api/phone/chat/${SHELL}/rename`]) {
        expect([404, 405], route).toContain((await get(route, SERVE)).status)
    }
    // only phone.html's own chunks: the desktop entry's are not served
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'out/renderer/.vite/manifest.json'), 'utf8')) as Record<string, { file: string }>
    const pageResponse = await get('/', SERVE)
    expect(pageResponse.status).toBe(200)
    expect(pageResponse.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect((await get(`/${manifest['phone.html'].file}`)).status).toBe(200)
    expect((await get(`/${manifest['index.html'].file}`)).status).toBe(404)
    expect((await get('/sw.js')).status).toBe(200)

    // --- the phone: pair with the Mac's code ---
    mark("the phone: pair with the Mac's code")
    const phone = await openPhone(app, `${base}/`, 'phone-a')
    await expect(phone.getByTestId('phone-pair')).toBeVisible()
    await expect(phone.getByTestId('phone-pair-reason')).toContainText('Enter the code from the Mac')
    await shot(phone, 'phone-pair-390.png')
    await page.getByTestId('phone-pair-drive').click()
    const code = (await page.getByTestId('phone-pair-code-mac').textContent())!.replace(/\D/g, '')
    expect(code).toMatch(/^\d{6}$/)
    await appShot(page, 'settings-pairing-1280.png')
    await phone.getByTestId('phone-pair-code').fill(code === '000000' ? '111111' : '000000')
    await phone.getByTestId('phone-pair-label').fill('Test iPhone')
    await phone.getByTestId('phone-pair-submit').click()
    await expect(phone.getByTestId('phone-pair-error')).toContainText('not the one on the Mac')
    await phone.getByTestId('phone-pair-code').fill(code)
    await phone.getByTestId('phone-pair-submit').click()

    // --- the list ---
    mark('the list')
    await expect(phone.getByTestId('phone-session-list')).toBeVisible({ timeout: 10_000 })
    await expect(phone.getByTestId('phone-who')).toContainText('Test iPhone')
    await expect(page.getByTestId('phone-device')).toHaveCount(1)
    await expect(page.getByTestId('phone-device')).toContainText('Test iPhone')
    // the paired phone and the owner (the serve-shaped requests above, within the last minute)
    await expect(page.getByTestId('phone-badge')).toContainText('Phone on · 2 connected', { timeout: 10_000 })
    // One list in the Mac's order — the sidebar's All sessions (List) top to bottom, compared row
    // for row with the desktop's own DOM. No Workspaces / Folders switch any more.
    await expect(phone.getByTestId('phone-group-workspaces')).toHaveCount(0)
    await expect(phone.getByTestId('phone-group-folders')).toHaveCount(0)
    const phoneOrder = (): Promise<string[]> =>
        phone.locator('[data-testid="phone-session-row"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-session-id') ?? ''))
    const macOrder = (): Promise<string[]> =>
        page.locator('[data-testid="sidebar-all-sessions"] [data-session-item]').evaluateAll((rows) => [...new Set(rows.map((row) => row.getAttribute('data-session-item') ?? ''))])
    // Settings (still open from pairing) covers the sidebar: closed for this, opened again after
    await page.locator('h2:has-text("Settings") + button').click()
    await expect(page.getByTestId('phone-settings')).toHaveCount(0)
    await page.getByTestId('sidebar-view-toggle').click()
    await expect(page.getByTestId('sidebar-all-sessions')).toBeVisible()
    const firstOrder = await macOrder()
    expect(firstOrder).toEqual(expect.arrayContaining([CLAUDE, CLAUDE2, SHELL]))
    await expect.poll(phoneOrder, { timeout: 10_000 }).toEqual(firstOrder)
    // as on the Mac: the session folder first, then the rest with the pinned shell on top and a line under it
    expect([...firstOrder.slice(0, 2)].sort()).toEqual([CLAUDE, CLAUDE2].sort())
    expect(firstOrder[2]).toBe(SHELL)
    await expect(phone.getByTestId('phone-list-folder')).toHaveText(['Agents', 'No folder'])
    await expect(phone.getByTestId('phone-pinned-divider')).toHaveCount(1)
    await expect(phone.locator(`[data-testid="phone-session-row"][data-session-id="${CLAUDE2}"] [data-testid="phone-row-workspace"]`)).toHaveText('T76 second')
    await shot(phone, 'phone-list-390.png')
    await appShot(page, 'mac-all-sessions-1280.png')
    // the Mac's order moves — a session looked at goes up — and the phone follows it, both ways
    for (const looked of [CLAUDE2, CLAUDE]) {
        await page.locator(`[data-testid="sidebar-all-sessions"] [data-session-item="${looked}"]`).first().click()
        // the sidebar holds its rows still while the pointer is over the list; off it, it catches up
        await page.mouse.move(900, 500)
        await expect.poll(async () => (await macOrder())[0], { timeout: 10_000 }).toBe(looked)
        const moved = await macOrder()
        await expect.poll(phoneOrder, { timeout: 10_000 }).toEqual(moved)
    }
    await page.getByTestId('sidebar-view-toggle').click()
    await page.locator('[title^="Settings"]').first().click()
    await page.getByTestId('settings-category-phone').click()
    await expect(page.getByTestId('phone-settings')).toBeVisible()
    // no make / delete / rename anywhere on the page
    await expect(phone.getByRole('button', { name: /new session|delete|rename/i })).toHaveCount(0)

    // --- Chat: the desktop Chat view, the phone's transport ---
    mark("Chat: the desktop Chat view, the phone's transport")
    await phone.locator(`[data-testid="phone-session-row"][data-session-id="${CLAUDE}"]`).click()
    await expect(phone.getByTestId('phone-session')).toHaveAttribute('data-lens', 'chat')
    const phoneChat = phone.getByTestId('chat-view')
    await expect(phoneChat.locator('[data-testid="chat-turn"][data-role="user"]').first()).toContainText('Add a guard to src/a.ts', { timeout: 10_000 })
    await expect(phoneChat.locator('.chat-md table th').first()).toHaveText('file')
    expect(phone.url()).toContain(`session=${CLAUDE}`)
    await shot(phone, 'phone-chat-390.png')
    const phoneComposer = phoneChat.getByTestId('chat-composer')
    await phoneComposer.fill('hello from phone')
    await phoneComposer.press('Enter')
    await waitForBufferText(page, CLAUDE, 'ANSWER[1]: hello from phone', 15_000)
    await expect(phoneChat.locator('[data-testid="chat-answer"]', { hasText: 'Echo: hello from phone' })).toBeVisible({ timeout: 15_000 })
    expect((await ptyState(page, CLAUDE)).phoneInputs.join('|')).toContain('chat message sent')

    // --- the question card, answered from the phone ---
    mark('the question card, answered from the phone')
    await expect(phoneChat.getByTestId('chat-working')).toHaveCount(0, { timeout: 15_000 })
    await phoneComposer.fill('ASK')
    await phoneComposer.press('Enter')
    const card = phoneChat.getByTestId('chat-prompt-card')
    await expect(card).toBeVisible({ timeout: 10_000 })
    await expect(card.getByTestId('chat-prompt-question')).toHaveText('Do you want to proceed?')
    // the list shows the session waiting, with the question
    await phone.getByTestId('phone-menu-button').click()
    const waitingRow = phone.locator(`[data-testid="phone-session-row"][data-session-id="${CLAUDE}"]`)
    await expect(waitingRow).toHaveAttribute('data-state', 'waiting', { timeout: 10_000 })
    await expect(waitingRow.getByTestId('phone-row-question')).toContainText('Do you want to proceed?')
    await shot(phone, 'phone-list-waiting-390.png')
    // a tap on the dimmed strip right of the drawer closes it
    await phone.getByTestId('phone-scrim').click({ position: { x: 375, y: 420 } })
    await shot(phone, 'phone-card-390.png')
    await card.locator('[data-testid="chat-prompt-option"][data-index="0"]').click()
    await waitForBufferText(page, CLAUDE, 'CHOSE: Yes', 10_000)
    await expect(card).toHaveCount(0, { timeout: 10_000 })
    expect((await ptyState(page, CLAUDE)).phoneInputs.join('|')).toContain('answered a question card')

    // --- Terminal: the Mac's size, nothing resized ---
    mark("Terminal: the Mac's size, nothing resized")
    const macBefore = await ptyState(page, CLAUDE)
    expect(macBefore.size).not.toBeNull()
    await phone.getByTestId('phone-lens-terminal').click()
    const terminal = phone.getByTestId('phone-terminal')
    await expect(terminal).toHaveAttribute('data-status', 'live', { timeout: 10_000 })
    await expect(phone.getByTestId('phone-terminal-size')).toContainText(`${macBefore.size!.cols}×${macBefore.size!.rows}`)
    await expect(phone.getByTestId('phone-terminal-host')).toContainText('Claude Code (mock)')
    // drawn at the Mac's width and shrunk to the phone's
    const fit = await phone.getByTestId('phone-terminal-host').evaluate((host) => {
        const screen = host.querySelector('.xterm-screen') as HTMLElement
        return { natural: screen.offsetWidth, shown: host.getBoundingClientRect().width }
    })
    expect(fit.natural).toBeGreaterThan(390)
    expect(fit.shown).toBeLessThanOrEqual(392)
    // view first: no key bar until Type
    await expect(phone.getByTestId('phone-key-bar')).toHaveCount(0)
    await phone.getByTestId('phone-terminal-type').click()
    await expect(phone.getByTestId('phone-key-bar')).toBeVisible()
    await shot(phone, 'phone-terminal-keybar-390.png')
    await phone.getByTestId('phone-terminal-zoom-in').click()
    await phone.getByTestId('phone-terminal-zoom-in').click()
    await shot(phone, 'phone-terminal-zoomed-390.png')
    await phone.getByTestId('phone-terminal-fit').click()

    // a resize message from the phone is refused and changes nothing
    mark('resize message')
    // A resize from the phone is refused and changes nothing. The frames are over 32 bytes on
    // purpose: the bundled ws once froze main on exactly those (electron.vite.config.ts `define`).
    const within = <T,>(promise: Promise<T>, ms: number): Promise<T | 'TIMEOUT'> =>
        Promise.race([promise, new Promise<'TIMEOUT'>((resolve) => setTimeout(() => resolve('TIMEOUT'), ms))])
    const refused = await within(phone.evaluate(async ({ id }) => {
        const socket = new WebSocket(`ws://${location.host}/api/phone/terminal?session=${id}`)
        const replies: string[] = []
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 10_000)
            socket.onmessage = (event) => {
                const message = JSON.parse(String(event.data)) as { type: string; reason?: string }
                if (message.type === 'output') return
                replies.push(message.reason ?? message.type)
                if (message.type === 'snapshot') {
                    socket.send(JSON.stringify({ type: 'resize', cols: 40, rows: 20 }))
                    socket.send(JSON.stringify({ cols: 41, rows: 21, note: 'a size without a type' }))
                }
                if (replies.filter((r) => r === 'resize_not_allowed').length === 2) resolve()
            }
        })
        socket.close()
        return replies
    }, { id: CLAUDE }), 20_000)
    expect(refused).toEqual(['snapshot', 'resize_not_allowed', 'resize_not_allowed'])
    expect(await within(app.evaluate(() => (globalThis as { __phoneResizeRefused?: number }).__phoneResizeRefused), 5_000)).toBe(2)

    // the shell: type from the phone's input line and key bar
    await phone.getByTestId('phone-menu-button').click()
    await phone.locator(`[data-testid="phone-session-row"][data-session-id="${SHELL}"]`).click()
    await expect(phone.getByTestId('phone-session')).toHaveAttribute('data-lens', 'terminal')
    await expect(phone.getByTestId('phone-lens-chat')).toHaveCount(0)
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 10_000 })
    await phone.getByTestId('phone-terminal-type').click()
    await phone.getByTestId('phone-terminal-line').fill('echo PHONE_$((40+2))')
    await phone.getByTestId('phone-terminal-send').click()
    await waitForBufferText(page, SHELL, 'PHONE_42', 10_000)
    await expect(phone.getByTestId('phone-terminal-host')).toContainText('PHONE_42', { timeout: 10_000 })
    // Ctrl held + "c" in the line = ^C; the ^C key does the same
    await phone.getByTestId('phone-terminal-line').fill('sleep 30')
    await phone.getByTestId('phone-terminal-send').click()
    await page.waitForTimeout(500)
    await phone.locator('[data-key="ctrl-c"]').click()
    await phone.getByTestId('phone-terminal-line').fill('echo AFTER_$((1+1))')
    await phone.getByTestId('phone-terminal-send').click()
    await waitForBufferText(page, SHELL, 'AFTER_2', 10_000)
    expect((await ptyState(page, SHELL)).phoneInputs.join('|')).toContain('typed in the terminal')

    // the phone attached to both terminals and left: the Mac's ptys never changed size
    await phone.getByTestId('phone-menu-button').click()
    await phone.locator(`[data-testid="phone-session-row"][data-session-id="${CLAUDE}"]`).click()
    await phone.getByTestId('phone-lens-chat').click()
    await page.waitForTimeout(500)
    const macAfter = await ptyState(page, CLAUDE)
    expect(macAfter.size).toEqual(macBefore.size)
    expect(macAfter.resized).toBe(macBefore.resized)
    expect((await ptyState(page, SHELL)).resized).toBe(0)

    // --- alerts ---
    mark('alerts')
    // subscribed the way the page does it (headless Chromium has no push service)
    const subscribe = await fetch(`${base}/api/phone/push/subscribe`, {
        method: 'POST',
        headers: { ...SERVE, 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: { endpoint: 'https://push.example/t76', keys: { p256dh: 'p256', auth: 'auth' } } })
    })
    expect(subscribe.status).toBe(200)
    await expect(page.getByTestId('phone-settings')).toContainText('1 device turned alerts on', { timeout: 10_000 })
    // a question in the second session: one alert, with that session's chat as its address
    await page.evaluate((id) => window.api.sendChatMessage(id, 'ASK'), CLAUDE2)
    await expect.poll(() => pushLines(pushLog).filter((l) => l.payload.title === 'T76 Claude 2 needs you').length, { timeout: 15_000 }).toBe(1)
    const alert = pushLines(pushLog).find((l) => l.payload.title === 'T76 Claude 2 needs you')!
    expect(alert.payload.url).toBe(`/?session=${CLAUDE2}&view=chat`)
    expect(alert.payload.body).toBe('Do you want to proceed?')
    // answered and asked again within the minute: no second alert
    for (const key of ['\x1b[B', '\x1b[B', '\x1b[B', '\r']) {
        await writeToTerminal(page, CLAUDE2, key)
        await page.waitForTimeout(150)
    }
    await waitForBufferText(page, CLAUDE2, 'CHOSE: No', 10_000)
    await page.waitForTimeout(1500)
    await page.evaluate((id) => window.api.sendChatMessage(id, 'ASK'), CLAUDE2)
    await page.waitForTimeout(3000)
    expect(pushLines(pushLog).filter((l) => l.payload.title.startsWith('T76 Claude 2')).length).toBe(1)
    // someone at the Mac using the app: nothing goes out
    await app.evaluate(() => {
        (globalThis as { __phoneMacInUse?: boolean }).__phoneMacInUse = true
    })
    await page.evaluate((id) => window.api.sendChatMessage(id, 'ASK'), CLAUDE)
    await page.waitForTimeout(3000)
    expect(pushLines(pushLog).filter((l) => l.payload.title.startsWith('T76 Claude needs')).length).toBe(0)
    // the test alert always goes
    await page.getByTestId('phone-test-push').click()
    await expect(page.getByTestId('phone-push-result')).toHaveText('Sent to 1 device.')
    expect(pushLines(pushLog).some((l) => l.payload.title === 'CLI Manager')).toBe(true)
    // tapping the alert opens its address: that session's chat
    await phone.goto(`${base}${alert.payload.url}`)
    await expect(phone.getByTestId('phone-session')).toHaveAttribute('data-session-id', CLAUDE2)
    await expect(phone.getByTestId('phone-session')).toHaveAttribute('data-lens', 'chat')

    // --- a view-only device cannot type ---
    mark('a view-only device cannot type')
    await page.getByTestId('phone-pair-watch').click()
    const watchCode = (await page.getByTestId('phone-pair-code-mac').textContent())!.replace(/\D/g, '')
    const watcher = await openPhone(app, `${base}/?session=${SHELL}&view=terminal`, 'phone-b')
    await watcher.getByTestId('phone-pair-code').fill(watchCode)
    await watcher.getByTestId('phone-pair-submit').click()
    await expect(watcher.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 10_000 })
    // no Type to switch to (G8) — the server refusing it is checked just below
    await expect(watcher.getByTestId('phone-terminal-type')).toHaveCount(0)
    const watchSend = await watcher.evaluate(async ({ id }) => {
        const response = await fetch(`/api/phone/chat/${id}/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"text":"nope"}' })
        return response.status
    }, { id: CLAUDE })
    expect(watchSend).toBe(403)
    await expect(page.getByTestId('phone-device')).toHaveCount(2)

    // --- revoke, then off ---
    mark('revoke, then off')
    await page.locator('[data-testid="phone-device"]', { hasText: 'Test iPhone' }).getByTestId('phone-revoke').click()
    await expect(page.getByTestId('phone-device')).toHaveCount(1)
    await phone.reload()
    await expect(phone.getByTestId('phone-pair')).toBeVisible({ timeout: 10_000 })

    // the badge turns it off: the server closes and the watcher's socket drops
    await page.locator('h2:has-text("Settings") + button').click()
    await expect(page.getByTestId('phone-settings')).toHaveCount(0)
    await appShot(page, 'badge-on-1280.png')
    await page.getByTestId('phone-badge-off').click()
    await expect(page.getByTestId('phone-badge')).toHaveCount(0)
    await expect(page.getByTestId('phone-listening')).toHaveCount(0)
    await expect(watcher.getByTestId('phone-terminal')).not.toHaveAttribute('data-status', 'live', { timeout: 10_000 })
    await expect(fetch(`${base}/api/phone/me`)).rejects.toThrow()
    const saved = JSON.parse(fs.readFileSync(path.join(result.userDataDir, 'config.json'), 'utf8')) as { settings: { phone?: { enabled: boolean } } }
    expect(saved.settings.phone?.enabled).toBe(false)
    // nothing secret in config.json: the device list and keys live in userData/phone (0600)
    expect(JSON.stringify(saved)).not.toContain('tokenHash')
    for (const file of ['devices.json', 'vapid.json', 'push.json']) {
        expect(fs.statSync(path.join(result.userDataDir, 'phone', file)).mode & 0o777, file).toBe(0o600)
    }
    expect(await termText(page, CLAUDE)).toContain('CHOSE: Yes')
})

function rawStatus(port: number, route: string, headers: Record<string, string>): Promise<number> {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: route, headers }, (response) => {
            response.resume()
            resolve(response.statusCode ?? 0)
        })
        request.on('error', reject)
        request.end()
    })
}

/**
 * A phone: a 390×844 window of its own, in its own cookie jar (partition), loading the phone
 * page over HTTP like any browser. Electron's Chromium plays the phone's browser — the
 * Playwright browsers are not installed in CI, Electron is.
 */
async function openPhone(app: ElectronApplication, url: string, partition: string): Promise<Page> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow }, options) => {
        const win = new BrowserWindow({
            width: 390,
            height: 844,
            useContentSize: true,
            show: false,
            webPreferences: { partition: options.partition, backgroundThrottling: false }
        })
        void win.loadURL(options.url)
    }, { url, partition })
    const page = await opened
    await page.waitForLoadState('domcontentloaded')
    return page
}
