import { test, expect, Page, ElectronApplication, _electron as electron } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T52 — Inbox: a session asks for the user's hands through the Control API.
 *
 * POST /v1/inbox puts a request (login / review / question / other, one line,
 * optional link) in the app's inbox. The sidebar header's bell shows the unread
 * count, the asking session's row gets an orange dot and the Dock badge carries
 * the count. Opening a request shows its session; looking at a session (window
 * focused) reads its requests. Requests survive a restart and go with their
 * session.
 *
 * Judged at the ends: the API's own list (`read`), the sidebar DOM, which
 * terminal is visible, app.dock.getBadge() in main, shell.openExternal stubbed
 * in main (T49 style), and config.json for the restart.
 *
 * INBOX_SHOTS=<folder> saves 1280 and 390 wide captures. The first two
 * (sidebar-head-*) are taken before any inbox call, so the same spec run
 * against the old code still captures the "before" header.
 */

const A = 's-t52-a'
const B = 's-t52-b'
const C = 's-t52-c'

interface Discovery {
    url: string
    token: string
}

interface ApiInboxRequest {
    id: string
    sessionId: string
    sessionName: string
    kind: string
    text: string
    url?: string
    read: boolean
}

const visibleSession = (page: Page): Promise<string> => page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-session-id]'))
        .filter((el) => getComputedStyle(el).visibility === 'visible')
        .map((el) => el.getAttribute('data-session-id'))
        .join(',') || 'none')

const sidebarBell = (page: Page) => page.locator('[data-testid="inbox-button"][data-inbox-placement="sidebar"]')
const headerBell = (page: Page) => page.locator('[data-testid="inbox-button"][data-inbox-placement="header"]')
const popover = (page: Page) => page.getByTestId('inbox-popover')
const dot = (page: Page, sessionId: string) => page.locator(`[data-inbox-dot="${sessionId}"]`)

const dockBadge = (app: ElectronApplication): Promise<string> =>
    app.evaluate(({ app: electronApp }) => (process.platform === 'darwin' ? electronApp.dock?.getBadge() ?? '' : 'n/a'))

test.describe('T52 inbox', () => {
    let ctx: LaunchResult | undefined
    let relaunched: ElectronApplication | null = null
    const temps: string[] = []
    const tempDir = (prefix: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        temps.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    const shotsDir = (): string | undefined => {
        const shots = process.env.INBOX_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })
        return shots
    }

    let homeDir = ''

    async function launch(): Promise<LaunchResult> {
        const folder = tempDir('climanager-t52-ws-')
        homeDir = tempDir('climanager-t52-home-')
        return launchAppWithWorkspaces(
            [{
                id: 'ws-t52', name: 'T52WS', path: folder, sessions: [
                    { id: A, name: 'T52A login agent' },
                    { id: B, name: 'T52B review agent' },
                    { id: C, name: 'T52C' }
                ]
            }],
            {
                settings: { controlApi: { enabled: true, port: 0 }, showHomeWorkspace: false },
                env: { CLIMANAGER_HOME: homeDir }
            }
        )
    }

    async function apiFor(home: string) {
        const discoveryPath = path.join(home, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
        return async <T = unknown>(method: string, route: string, body?: unknown, caller?: string): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    'X-Client-Name': 't52',
                    ...(caller !== undefined ? { 'X-Caller-Session': caller } : {})
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }
    }

    test('requests reach the bell, the row and the Dock; opening or looking reads them', async () => {
        ctx = await launch()
        const { app, page } = ctx
        const shots = shotsDir()
        await resizeMainWindow(app, 1280, 800)
        await activateSession(page, 'T52C')

        // Before any request: what the header looks like (the "before" capture on the old code).
        if (shots) {
            await page.screenshot({ path: path.join(shots, 'sidebar-head-1280.png') })
            await resizeMainWindow(app, 390, 800)
            await page.waitForTimeout(400)
            await page.screenshot({ path: path.join(shots, 'sidebar-head-390.png') })
            await resizeMainWindow(app, 1280, 800)
            await page.waitForTimeout(400)
        }

        await app.evaluate(({ shell }) => {
            const urls: string[] = []
            ;(globalThis as unknown as { __opened: string[] }).__opened = urls
            shell.openExternal = async (url: string) => { urls.push(url) }
        })
        const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

        const api = await apiFor(homeDir)
        const list = async (): Promise<ApiInboxRequest[]> =>
            (await api<{ requests: ApiInboxRequest[] }>('GET', '/v1/inbox')).json.requests

        // --- Refused: no session to lead to, a reserved link, bad input ------
        const noSession = await api<{ error: { code: string } }>('POST', '/v1/inbox', { kind: 'login', text: 'x' })
        expect(noSession.status, JSON.stringify(noSession.json)).toBe(400)
        expect(noSession.json.error.code).toBe('session_required')
        expect((await api('POST', '/v1/inbox', { text: 'x' }, 'no-such-session')).status).toBe(404)
        expect((await api('POST', '/v1/inbox', { text: 'x', sessionId: 'no-such-session' })).status).toBe(404)
        expect((await api('POST', '/v1/inbox', { text: 'x', url: 'javascript:alert(1)' }, A)).status).toBe(400)
        expect((await api('POST', '/v1/inbox', { text: 'x', url: 'not a url' }, A)).status).toBe(400)
        expect((await api('POST', '/v1/inbox', { text: 'x', url: `https://example.com/${'a'.repeat(2000)}` }, A)).status).toBe(400)
        expect((await api('POST', '/v1/inbox', { kind: 'urgent', text: 'x' }, A)).status).toBe(400)
        expect((await api('POST', '/v1/inbox', { kind: 'login' }, A)).status).toBe(400)
        expect(await list()).toEqual([])
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '0')

        // --- A asks to sign in (header), twice: one request -----------------
        const first = await api<{ request: ApiInboxRequest; created: boolean }>(
            'POST', '/v1/inbox', { kind: 'login', text: 'Sign in to Aside\nthen tell me', url: 'https://example.com/login' }, A
        )
        expect(first.status, JSON.stringify(first.json)).toBe(200)
        expect(first.json.created).toBe(true)
        expect(first.json.request.text).toBe('Sign in to Aside then tell me')
        expect(first.json.request.sessionName).toBe('T52A login agent')
        const again = await api<{ request: ApiInboxRequest; created: boolean }>(
            'POST', '/v1/inbox', { kind: 'login', text: 'Sign in to Aside then tell me', url: 'https://example.com/login' }, A
        )
        expect(again.json.created).toBe(false)
        expect(again.json.request.id).toBe(first.json.request.id)
        expect(await list()).toHaveLength(1)
        // Asking for the user is not the AI working in the session.
        expect((await api<{ aiControlled: boolean }>('GET', `/v1/sessions/${A}`)).json.aiControlled).toBe(false)

        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '1')
        await expect(sidebarBell(page).getByTestId('inbox-count')).toHaveText('1')
        await expect(dot(page, A)).toBeVisible()
        if (process.platform === 'darwin') await expect.poll(() => dockBadge(app)).toBe('1')

        // --- B asks for a review (sessionId in the body, no header) ---------
        const review = await api<{ request: ApiInboxRequest }>('POST', '/v1/inbox', { kind: 'review', text: 'Review the report', sessionId: B })
        expect(review.status).toBe(200)
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '2')
        await expect(dot(page, B)).toBeVisible()
        await expect(dot(page, C)).toHaveCount(0)
        if (shots) await page.screenshot({ path: path.join(shots, 'bell-count-1280.png') })

        // --- Opening a request shows its session and reads it ---------------
        await sidebarBell(page).click()
        await expect(popover(page)).toBeVisible()
        const reviewRow = popover(page).locator(`[data-inbox-request="${review.json.request.id}"]`)
        await expect(reviewRow).toContainText('T52B review agent')
        await expect(reviewRow).toContainText('Review the report')
        await expect(reviewRow).toHaveAttribute('data-read', 'false')
        // Newest first: B's review above A's sign-in.
        const order = await popover(page).locator('[data-inbox-request]').evaluateAll((els) => els.map((el) => el.getAttribute('data-inbox-request')))
        expect(order).toEqual([review.json.request.id, first.json.request.id])
        if (shots) await page.screenshot({ path: path.join(shots, 'popover-1280.png') })
        await reviewRow.click()
        await expect(popover(page)).toHaveCount(0)
        await expect.poll(() => visibleSession(page)).toBe(B)
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '1')
        await expect(dot(page, B)).toHaveCount(0)
        expect((await list()).find((r) => r.id === review.json.request.id)?.read).toBe(true)

        // --- Going to the session from the sidebar reads it too -------------
        await activateSession(page, 'T52A login agent')
        await expect.poll(() => visibleSession(page)).toBe(A)
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '0')
        await expect(sidebarBell(page).getByTestId('inbox-count')).toHaveCount(0)
        await expect(dot(page, A)).toHaveCount(0)
        if (process.platform === 'darwin') await expect.poll(() => dockBadge(app)).toBe('')

        // --- Links: allowed ones reach the OS, others do not ----------------
        const obsidian = await api<{ request: ApiInboxRequest }>('POST', '/v1/inbox', { kind: 'other', text: 'Open the note', url: 'obsidian://open?vault=x' }, C)
        expect(obsidian.status).toBe(200)
        await sidebarBell(page).click()
        await popover(page).locator(`[data-inbox-request="${first.json.request.id}"] [data-inbox-link]`).click()
        await expect.poll(opened).toEqual(['https://example.com/login'])
        const blocked = popover(page).locator(`[data-inbox-request="${obsidian.json.request.id}"] [data-inbox-link]`)
        await expect(blocked).toHaveAttribute('data-allowed', 'false')
        await blocked.click()
        await page.waitForTimeout(300)
        expect(await opened()).toEqual(['https://example.com/login'])
        // The link click did not navigate away: the popover is still open on A.
        await expect(popover(page)).toBeVisible()
        expect(await visibleSession(page)).toBe(A)

        // --- Mark all read ---------------------------------------------------
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '1')
        await popover(page).getByTestId('inbox-mark-all-read').click()
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '0')
        await page.keyboard.press('Escape')
        await expect(popover(page)).toHaveCount(0)

        // --- The session on screen reads its request at once; not while the window is in the background ---
        const onScreen = await api<{ request: ApiInboxRequest }>('POST', '/v1/inbox', { kind: 'question', text: 'Which port?' }, A)
        expect(onScreen.status).toBe(200)
        await expect.poll(async () => (await list()).find((r) => r.id === onScreen.json.request.id)?.read).toBe(true)
        // Window blur/focus events stand in for switching to another app (the test window is never shown).
        await page.evaluate(() => window.dispatchEvent(new Event('blur')))
        const background = await api<{ request: ApiInboxRequest }>('POST', '/v1/inbox', { kind: 'question', text: 'Still there?' }, A)
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '1')
        await page.waitForTimeout(500)
        expect((await list()).find((r) => r.id === background.json.request.id)?.read).toBe(false)
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '0')

        // --- The sender resolves it itself ----------------------------------
        const selfResolved = await api<{ request: ApiInboxRequest }>('POST', '/v1/inbox', { kind: 'login', text: 'Sign in again' }, B)
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '1')
        const read = await api<ApiInboxRequest>('POST', `/v1/inbox/${selfResolved.json.request.id}/read`)
        expect(read.status).toBe(200)
        expect(read.json.read).toBe(true)
        expect((await api('POST', '/v1/inbox/no-such-id/read')).status).toBe(404)
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '0')
        const unreadOnly = await api<{ unreadCount: number; requests: ApiInboxRequest[] }>('GET', '/v1/inbox?unread=1')
        expect(unreadOnly.json).toEqual({ unreadCount: 0, requests: [] })

        // --- MCP: the same through tools ------------------------------------
        const mcp = async (method: string, params: Record<string, unknown>, caller?: string) =>
            (await api<{ result: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }>(
                'POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, caller
            )).json.result
        const tools = (await mcp('tools/list', {})).tools!.map((t) => t.name)
        expect(tools).toEqual(expect.arrayContaining(['inbox_notify', 'inbox_list']))
        const viaMcp = await mcp('tools/call', { name: 'inbox_notify', arguments: { kind: 'review', text: 'Look at the diff' } }, B)
        expect(viaMcp.isError ?? false).toBe(false)
        expect(JSON.parse(viaMcp.content![0].text).request.sessionId).toBe(B)
        const listed = JSON.parse((await mcp('tools/call', { name: 'inbox_list', arguments: { unread_only: true } })).content![0].text)
        expect(listed.unreadCount).toBe(1)
        expect(listed.requests[0].text).toBe('Look at the diff')
        const mcpRefused = await mcp('tools/call', { name: 'inbox_notify', arguments: { text: 'no session' } })
        expect(mcpRefused.isError).toBe(true)

        // --- Sidebar closed: the bell moves to the main header --------------
        await page.locator('button[title="Close Sidebar"]').click()
        await expect(sidebarBell(page)).toHaveCount(0)
        await expect(headerBell(page)).toHaveAttribute('data-unread', '1')
        if (shots) await page.screenshot({ path: path.join(shots, 'header-bell-1280.png') })
        await headerBell(page).click()
        await expect(popover(page)).toBeVisible()
        await page.keyboard.press('Escape')

        if (shots) {
            await resizeMainWindow(app, 390, 800)
            await page.waitForTimeout(400)
            await page.screenshot({ path: path.join(shots, 'header-bell-390.png') })
            await page.locator('button[title="Open Sidebar"]').click()
            await expect(sidebarBell(page)).toBeVisible()
            await page.screenshot({ path: path.join(shots, 'bell-count-390.png') })
            await sidebarBell(page).click()
            await expect(popover(page)).toBeVisible()
            const box = await popover(page).boundingBox()
            expect(box!.x).toBeGreaterThanOrEqual(0)
            expect(box!.x + box!.width).toBeLessThanOrEqual(390)
            await page.screenshot({ path: path.join(shots, 'popover-390.png') })
            await page.keyboard.press('Escape')
            await resizeMainWindow(app, 1280, 800)
        } else {
            await page.locator('button[title="Open Sidebar"]').click()
        }

        // --- A closed session takes its requests with it --------------------
        expect((await api('DELETE', `/v1/sessions/${B}`)).status).toBe(200)
        expect((await list()).filter((r) => r.sessionId === B)).toEqual([])
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '0')
        // …and so does one deleted from the sidebar.
        expect((await list()).some((r) => r.sessionId === C)).toBe(true)
        const rowC = page.locator(`[data-session-item="${C}"]`)
        await rowC.hover()
        await rowC.getByTitle('Delete session').click()
        await expect(rowC).toHaveCount(0)
        await expect.poll(async () => (await list()).some((r) => r.sessionId === C)).toBe(false)
    })

    test('the bell leaves the sidebar title whole; collapse all and new folder sit in the … menu', async () => {
        ctx = await launch()
        const { app, page, userDataDir } = ctx
        const shots = shotsDir()
        await resizeMainWindow(app, 1280, 800)

        // The header row is [title span][buttons]; the title must not be cut at the default sidebar width.
        const title = () => page.getByTestId('sidebar-search-toggle').evaluate((button) => {
            const label = button.parentElement!.parentElement!.querySelector(':scope > span') as HTMLElement
            return { text: label.textContent, scroll: label.scrollWidth, client: label.clientWidth }
        })
        const workspaces = await title()
        expect(workspaces.text).toBe('Workspaces')
        expect(workspaces.scroll, JSON.stringify(workspaces)).toBeLessThanOrEqual(workspaces.client)
        await expect(sidebarBell(page)).toBeVisible()
        // The longer "All sessions" title too.
        await page.getByTestId('sidebar-view-toggle').click()
        await expect.poll(async () => (await title()).text).toBe('All sessions')
        const allSessions = await title()
        expect(allSessions.scroll, JSON.stringify(allSessions)).toBeLessThanOrEqual(allSessions.client)
        await page.getByTestId('sidebar-view-toggle').click()
        await expect.poll(async () => (await title()).text).toBe('Workspaces')

        // New Folder through the menu: the prompt opens and the folder is saved.
        await page.getByTestId('sidebar-more').click()
        await expect(page.getByTestId('sidebar-more-menu')).toBeVisible()
        await expect(page.getByTestId('sidebar-collapse-all')).toHaveText('Collapse All')
        if (shots) await page.screenshot({ path: path.join(shots, 'sidebar-more-1280.png') })
        await page.getByTestId('sidebar-new-folder').click()
        await expect(page.getByTestId('sidebar-more-menu')).toHaveCount(0)
        const name = page.getByPlaceholder('Folder name')
        await expect(name).toBeFocused()
        await name.fill('T52 folder')
        await name.press('Enter')
        await expect.poll(() =>
            (JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).folders ?? []).map((f: { name: string }) => f.name)
        ).toContain('T52 folder')

        // Outside click and Escape close the menu without running anything.
        await page.getByTestId('sidebar-more').click()
        await page.mouse.click(900, 400)
        await expect(page.getByTestId('sidebar-more-menu')).toHaveCount(0)
        await page.getByTestId('sidebar-more').click()
        await page.keyboard.press('Escape')
        await expect(page.getByTestId('sidebar-more-menu')).toHaveCount(0)
    })

    test('unread requests survive a restart', async () => {
        ctx = await launch()
        const { page } = ctx
        await activateSession(page, 'T52C')
        const api = await apiFor(homeDir)
        const sent = await api<{ request: ApiInboxRequest }>('POST', '/v1/inbox', { kind: 'login', text: 'Sign in before the restart' }, A)
        expect(sent.status, JSON.stringify(sent.json)).toBe(200)
        await expect(sidebarBell(page)).toHaveAttribute('data-unread', '1')

        const userDataDir = ctx.userDataDir
        temps.push(userDataDir)
        const onDisk = () => JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).inbox ?? []
        expect(onDisk().map((r: { id: string }) => r.id)).toEqual([sent.json.request.id])
        await ctx.app.close()
        ctx = undefined

        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: {
                ...process.env,
                CLIMANGER_TEST_USERDATA: userDataDir,
                CLIMANGER_TERM_DEBUG: '1',
                CLIMANGER_TEST_HEADLESS: '1',
                CLIMANAGER_HOME: homeDir
            } as Record<string, string>
        })
        const page2 = await relaunched.firstWindow()
        await page2.locator(`[data-session-item="${A}"]`).waitFor({ timeout: 30_000 })
        await expect(sidebarBell(page2)).toHaveAttribute('data-unread', '1')
        await expect(dot(page2, A)).toBeVisible()
        if (process.platform === 'darwin') await expect.poll(() => dockBadge(relaunched!)).toBe('1')
        const api2 = await apiFor(homeDir)
        const after = (await api2<{ requests: ApiInboxRequest[] }>('GET', '/v1/inbox')).json.requests
        expect(after.map((r) => [r.id, r.read])).toEqual([[sent.json.request.id, false]])
    })
})
