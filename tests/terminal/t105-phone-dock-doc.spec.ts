import { test, expect, type CDPSession, type ElectronApplication, type FrameLocator, type Locator, type Page } from '@playwright/test'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { dockItemKey, type DockDoc } from '../../src/main/phone/phoneDock'
import { PhoneDevices } from '../../src/main/phone/PhoneDevices'
import { PhoneServer } from '../../src/main/phone/PhoneServer'
import type { PhoneDocOpened, PhoneDocRefused, PhoneFileInfo, PhoneFileRefused } from '../../src/shared/phone'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T105 — the two halves meeting: a Dock row opens its report in the document frame, and the report's comment reaches the
 * session through the same sheet a chat's link gets. The phone names only the row's key: main alone knows the path, and
 * the eight steps of the file judgement still run on it (decisions 0010, 0011). A view-only device sees the list and
 * opens nothing. The first half is the real PhoneServer on a real port; the second the real app against a fake dock.sock.
 *
 * T105_SHOTS=<dir> + T105_LABEL save captures before the checks.
 */

const AGENT = 's-agent'
const SHELL = 's-shell'

interface Harness {
    home: string
    project: string
    base: string
    drive: string
    watch: string
    logged: { id: string; detail: string }[]
    docs: Map<string, DockDoc>
    asked: string[]
    add(name: string, doc: DockDoc): string
    stop(): Promise<void>
}

async function startHarness(): Promise<Harness> {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't105-home-')))
    const project = path.join(home, 'project')
    fs.mkdirSync(project)
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 't105-data-'))
    const devices = new PhoneDevices(path.join(data, 'devices.json'))
    const docs = new Map<string, DockDoc>()
    const asked: string[] = []
    const logged: { id: string; detail: string }[] = []
    const push = { forgetOwner: () => undefined, publicKey: () => 'key', keysProblem: () => null, count: () => 0, onStatus: () => undefined }
    const server = new PhoneServer({
        devices,
        push: push as never,
        tailscale: { read: async () => ({ found: false, owner: null, dnsName: null }), peek: () => null } as never,
        staticDir: data,
        onStateChange: () => undefined,
        statusPoller: { start: () => undefined, stop: () => undefined },
        listSessions: () =>
            ({
                sessions: [
                    { id: AGENT, name: 'Agent', workspaceId: 'w', workspaceName: 'W', agent: 'claude', state: 'idle' },
                    { id: SHELL, name: 'Shell', workspaceId: 'w', workspaceName: 'W', agent: null, state: 'idle' }
                ],
                sessionFolders: []
            }) as never,
        sessionExists: (id: string) => id === AGENT || id === SHELL,
        // a chat that names nothing: whatever opens here is opened by the row alone
        conversation: { mentionedPaths: async () => ({ paths: new Set<string>(), cwd: project }) } as never,
        saveAttachment: () => ({ status: 'attached', path: '/tmp/x' }) as never,
        maskLine: (text: string) => text,
        recordPhoneInput: () => undefined,
        terminals: {} as never,
        subscribeConversation: () => () => undefined,
        dock: {
            installed: () => true,
            read: async () => null,
            docFor: (key: string) => {
                asked.push(key)
                return docs.get(key) ?? null
            }
        },
        files: {
            home,
            protectedPlaces: [data],
            maskLines: (lines) => ({ lines, masked: 0 }),
            record: (id, detail) => logged.push({ id, detail })
        }
    })
    const state = await server.apply({ enabled: true, port: 0 } as never)
    expect(state.running).toBe(true)
    const pair = (role: 'drive' | 'watch'): string => {
        const { code } = devices.startPairing(role)
        const paired = devices.pair(code, role)
        if ('error' in paired) throw new Error(paired.error)
        return `climanager_phone=${paired.token}`
    }
    return {
        home,
        project,
        base: `http://127.0.0.1:${state.port}`,
        drive: pair('drive'),
        watch: pair('watch'),
        logged,
        docs,
        asked,
        add: (name, doc) => {
            const key = dockItemKey(`file:${name}`)
            docs.set(key, doc)
            return key
        },
        stop: () => server.stop()
    }
}

async function openDocument(h: Harness, body: Record<string, unknown>, cookie = h.drive, headers: Record<string, string> = {}): Promise<{ status: number; text: string; body: PhoneDocOpened | PhoneDocRefused }> {
    const response = await fetch(`${h.base}/api/phone/doc/open`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    const text = await response.text()
    return { status: response.status, text, body: JSON.parse(text) }
}

const report = (h: Harness, name = 'report.html', content = '<!doctype html><title>Row report</title><p>words</p>'): string => {
    const file = path.join(h.project, name)
    fs.writeFileSync(file, content)
    return file
}

test.describe('T105 a Dock row grants its own document', () => {
    let h: Harness
    test.beforeAll(async () => {
        h = await startHarness()
    })
    test.afterAll(async () => {
        await h.stop()
    })

    test('the key is all the phone sends, and the path does not come back', async () => {
        const file = report(h)
        const key = h.add('plain', { kind: 'file', path: file, session: { id: AGENT, name: 'Agent' } })
        const { status, text, body } = await openDocument(h, { dock: key })
        expect(status, text).toBe(200)
        const opened = body as PhoneDocOpened
        expect(opened.title).toBe('Row report')
        expect(opened.target?.id).toBe(AGENT)
        expect(opened.rawUrl).toContain(`dock=${key}`)
        expect(opened.rawUrl).not.toContain('path=')
        expect(text, 'the Mac path stays on the Mac').not.toContain(h.home)
        const page = await fetch(`${h.base}${opened.url}`)
        expect(await page.text()).toContain('words')
    })

    test('a path sent beside the key is not read: the row grants only its own file', async () => {
        const key = h.add('beside', { kind: 'file', path: report(h, 'beside.html'), session: null })
        const other = report(h, 'other.html', '<!doctype html><title>Other</title>')
        const { status, body } = await openDocument(h, { dock: key, path: other, session: AGENT })
        expect(status).toBe(200)
        expect((body as PhoneDocOpened).rel).toBe('beside.html')
    })

    test('who gets a comment: the row\'s agent session, or the person chooses', async () => {
        const file = report(h, 'who.html')
        const none = await openDocument(h, { dock: h.add('none', { kind: 'file', path: file, session: null }) })
        expect((none.body as PhoneDocOpened).target).toBeNull()
        const shell = await openDocument(h, { dock: h.add('shell', { kind: 'file', path: file, session: { id: SHELL, name: 'Shell' } }) })
        expect((shell.body as PhoneDocOpened).target).toBeNull()
    })

    test('a key that is not a row, or a row that is a link, opens nothing', async () => {
        const before = await openDocument(h, { dock: 'no-such-key' })
        expect(before.status).toBe(404)
        expect((before.body as PhoneDocRefused).reason).toBe('not_found')
        const link = await openDocument(h, { dock: h.add('link', { kind: 'link', url: 'https://claude.ai/code/artifact/x' }) })
        expect(link.status).toBe(404)
        const asFile = await fetch(`${h.base}/api/phone/file?dock=no-such-key`, { headers: { cookie: h.drive } })
        expect(asFile.status).toBe(404)
        expect(((await asFile.json()) as PhoneFileRefused).reason).toBe('not_found')
    })

    test('a view-only device is refused before any row is looked up', async () => {
        const key = h.add('watched', { kind: 'file', path: report(h, 'watched.html'), session: null })
        h.asked.length = 0
        const doc = await openDocument(h, { dock: key }, h.watch)
        expect(doc.status).toBe(403)
        expect((doc.body as PhoneDocRefused).reason).toBe('view_only')
        for (const route of ['file', 'file/raw']) {
            const response = await fetch(`${h.base}/api/phone/${route}?dock=${key}`, { headers: { cookie: h.watch } })
            expect(response.status, route).toBe(403)
        }
        expect(h.asked).toEqual([])
    })

    test('the other steps still run on a row\'s path: keys, the outside, a link to a key, another site', async () => {
        const ssh = path.join(h.home, '.ssh')
        fs.mkdirSync(ssh, { recursive: true })
        const hidden = path.join(ssh, 'page.html')
        fs.writeFileSync(hidden, '<!doctype html><title>Key</title>')
        const protectedRow = await openDocument(h, { dock: h.add('protected', { kind: 'file', path: hidden, session: null }) })
        expect((protectedRow.body as PhoneDocRefused).reason).toBe('protected')

        // this harness's home is a temp folder, so the repository lies outside it and outside the session's folder
        const outside = path.join(REPO_ROOT, 'tests/fixtures/phone-doc/eli5.html')
        const outsideRow = await openDocument(h, { dock: h.add('outside', { kind: 'file', path: outside, session: null }) })
        expect((outsideRow.body as PhoneDocRefused).reason).toBe('outside_roots')

        const linkToKey = path.join(h.project, 'innocent.html')
        fs.symlinkSync(hidden, linkToKey)
        const linked = await openDocument(h, { dock: h.add('linked', { kind: 'file', path: linkToKey, session: null }) })
        expect((linked.body as PhoneDocRefused).reason).toBe('protected')

        const gone = await openDocument(h, { dock: h.add('gone', { kind: 'file', path: path.join(h.project, 'gone.html'), session: null }) })
        expect((gone.body as PhoneDocRefused).reason).toBe('not_found')

        const notHtml = path.join(h.project, 'notes.txt')
        fs.writeFileSync(notHtml, 'words')
        const wrong = await openDocument(h, { dock: h.add('wrong', { kind: 'file', path: notHtml, session: null }) })
        expect((wrong.body as PhoneDocRefused).reason).toBe('not_html')

        const key = h.add('site', { kind: 'file', path: report(h, 'site.html'), session: null })
        const cross = await openDocument(h, { dock: key }, h.drive, { 'Sec-Fetch-Site': 'cross-site' })
        expect((cross.body as PhoneDocRefused).reason).toBe('cross_site')
        const crossFile = await fetch(`${h.base}/api/phone/file?dock=${key}`, { headers: { cookie: h.drive, 'Sec-Fetch-Site': 'cross-site' } })
        expect(crossFile.status).toBe(403)
    })

    test('saving the report goes by the key too, and stays a file', async () => {
        const key = h.add('saved', { kind: 'file', path: report(h, 'saved.html'), session: null })
        const opened = (await openDocument(h, { dock: key })).body as PhoneDocOpened
        const saved = await fetch(`${h.base}${opened.rawUrl}&download=1`, { headers: { cookie: h.drive } })
        expect(saved.status).toBe(200)
        expect(saved.headers.get('content-type')).toBe('application/octet-stream')
        expect(saved.headers.get('content-disposition')).toContain('attachment')
        expect(await saved.text()).toContain('words')
        const info = await fetch(`${h.base}/api/phone/file?dock=${key}`, { headers: { cookie: h.drive } })
        expect(((await info.json()) as PhoneFileInfo).status).toBe('ok')
    })

    test('the log names the row\'s session, and is silent when there is none', async () => {
        const quiet = h.add('quiet', { kind: 'file', path: report(h, 'quiet.html'), session: null })
        h.logged.length = 0
        await openDocument(h, { dock: quiet })
        expect(h.logged).toEqual([])
        const noisy = h.add('noisy', { kind: 'file', path: report(h, 'noisy.html'), session: { id: AGENT, name: 'Agent' } })
        await openDocument(h, { dock: noisy })
        expect(h.logged.map((entry) => entry.id)).toEqual([AGENT])
        expect(h.logged[0].detail).toMatch(/^document opened \(html, /)
        expect(h.logged[0].detail).not.toContain('noisy')
    })
})

// ---------------------------------------------------------------------------
// The real app: ☰ → Dock → the report → a comment → the session
// ---------------------------------------------------------------------------

const CLAUDE = 't105-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-00000000e105'
const OWNER = 'owner-t105@example.com'
const PORT = 47905
const DPR = 3
const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures/phone-doc')
const LABEL = process.env.T105_LABEL ?? 'run'

let result: LaunchResult | null = null
let socketServer: net.Server | null = null
let socketFile: string | null = null

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
    if (socketServer) await new Promise<void>((resolve) => socketServer!.close(() => resolve()))
    socketServer = null
    if (socketFile) fs.rmSync(socketFile, { force: true })
    socketFile = null
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T105_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

interface Launched {
    app: ElectronApplication
    page: Page
    base: string
    transcript: string
    review: string
}

async function launch(): Promise<Launched> {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t105-')))
    const project = path.join(home, 'project')
    const review = path.join(project, 'review')
    fs.mkdirSync(project, { recursive: true })
    fs.cpSync(FIXTURES, review, { recursive: true })
    const claudeDir = path.join(home, 'claude')
    const folder = path.join(claudeDir, 'projects', project.replace(/[^A-Za-z0-9]/g, '-'))
    fs.mkdirSync(folder, { recursive: true })
    const transcript = path.join(folder, `${CLAUDE_ID}.jsonl`)
    // the chat never names the report: the row is what grants it
    fs.writeFileSync(transcript, '')
    const row = (name: string, extra: Record<string, unknown>): Record<string, unknown> => {
        const file = path.join(review, name)
        return { key: `file:${file}`, url: `file://${file}`, title: name, sub: '~/project/review', at: 1, pinned: false, missing: false, ...extra }
    }
    const rows = {
        open: [row('eli5.html', { title: 'Session report', sessionId: CLAUDE }), row('ba.html', { title: 'Orphan page' })],
        closed: [row('hfk/hfk.html', { title: 'Deleted report', missing: true }), { key: 'artifact:x', url: 'https://claude.ai/code/artifact/x', title: 'Artifact page', sub: 'Claude artifact', at: 1, pinned: false, missing: false }]
    }
    socketFile = path.join('/tmp', `t105-${process.pid}.sock`)
    fs.rmSync(socketFile, { force: true })
    socketServer = net.createServer((socket) => {
        socket.on('error', () => undefined)
        socket.on('data', () => socket.write(`${JSON.stringify({ id: 'x', ok: true, protocol: 1, extVersion: '0.7.0', missingSupported: true, ...rows })}\n`))
    })
    await new Promise<void>((resolve) => socketServer!.listen(socketFile!, resolve))
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t105', name: 'T105 project', path: project, sessions: [{ id: CLAUDE, name: 'T105 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 200` }] }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir, ARTIFACT_DOCK_SOCKET: socketFile } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 30_000)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, page, base: `http://127.0.0.1:${state.port}`, transcript, review }
}

/** Main records every request that leaves this window. `owner: false` comes in as a paired device instead of `tailscale serve`'s owner. */
async function openPhone(app: ElectronApplication, url: string, partition: string, owner = true): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        const seen: string[] = []
        ;(globalThis as Record<string, unknown>)[`requests:${o.partition}`] = seen
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            seen.push(`${details.method} ${details.url} ${details.uploadData ? Buffer.concat(details.uploadData.map((part) => part.bytes ?? Buffer.alloc(0))).toString('utf8') : ''}`)
            callback({ requestHeaders: o.owner ? { ...details.requestHeaders, 'Tailscale-User-Login': o.login, 'X-Forwarded-For': '100.101.102.103' } : details.requestHeaders })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, login: OWNER, owner })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

const requestsOf = (app: ElectronApplication, partition: string): Promise<string[]> =>
    app.evaluate((_electron, name) => (globalThis as unknown as Record<string, string[]>)[`requests:${name}`] ?? [], partition)

async function tap(cdp: CDPSession, page: Page, target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    const box = (await target.boundingBox())!
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** The frame is its own process: see T102 for why this is the gesture and not a touch. */
async function tapInFrame(cdp: CDPSession, page: Page, target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    const box = (await target.boundingBox())!
    await cdp.send('Input.synthesizeTapGesture', { x: box.x + box.width / 2, y: box.y + box.height / 2 })
}

const rowBody = (phone: Page, title: string): Locator => phone.locator(`[data-testid="phone-dock-row"]:has-text("${title}") [data-testid="phone-dock-row-body"]`)
const frameOf = (phone: Page): FrameLocator => phone.frameLocator('[data-testid="phone-doc-frame"]')

async function openDock(cdp: CDPSession, phone: Page): Promise<void> {
    await tap(cdp, phone, phone.getByTestId('phone-menu-button'))
    await tap(cdp, phone, phone.getByTestId('phone-dock-entry'))
    await expect(phone.getByTestId('phone-dock-panel')).toBeVisible()
    await expect(phone.getByTestId('phone-dock-row').first()).toBeVisible({ timeout: 10_000 })
}

test('T105 ☰ → Dock → a report → a comment → Send: it lands in the row\'s session', async () => {
    test.setTimeout(180_000)
    const { app, base, transcript, review } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't105-drive')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await phone.getByTestId('chat-composer').fill('half a thought')

    await openDock(cdp, phone)
    await shot(phone, 'dock')
    await tap(cdp, phone, rowBody(phone, 'Session report'))
    await expect(phone.getByTestId('phone-doc-frame')).toBeVisible({ timeout: 10_000 })
    await shot(phone, 'document')
    const frame = frameOf(phone)
    await expect(frame.locator('.eli5-fb-btn').first()).toBeVisible({ timeout: 15_000 })

    // the phone never held the path: not in its address, not in what it sent
    expect(phone.url()).not.toContain(review)
    const sent = await requestsOf(app, 't105-drive')
    const asked = sent.filter((line) => line.includes('/api/phone/doc/open'))
    expect(asked.length).toBeGreaterThan(0)
    for (const line of asked) {
        expect(line).toContain('"dock"')
        expect(line).not.toContain(review)
    }
    const dockRead = await phone.evaluate(() => fetch('/api/phone/dock').then((r) => r.text()))
    expect(dockRead).not.toContain(review)

    await tapInFrame(cdp, phone, frame.locator('.eli5-fb-btn').first())
    await frame.locator('#eli5-fb-ta-0').fill('dock-comment-words')
    await tapInFrame(cdp, phone, frame.locator('#eli5-fb-copy'))
    await expect(phone.getByTestId('phone-doc-sheet')).toBeVisible({ timeout: 5_000 })
    await shot(phone, 'sheet')
    expect(await phone.getByTestId('phone-doc-target').textContent()).toContain('T105 Claude')
    expect(await phone.getByTestId('phone-doc-text').textContent()).toContain('dock-comment-words')
    expect(fs.readFileSync(transcript, 'utf8'), 'nothing goes before Send').not.toContain('Phone comment')
    await expect(phone.getByTestId('phone-doc-send')).toBeEnabled({ timeout: 3_000 })
    await tap(cdp, phone, phone.getByTestId('phone-doc-send'))
    await expect(phone.getByTestId('phone-doc-notice')).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => fs.readFileSync(transcript, 'utf8').includes('dock-comment-words'), { timeout: 15_000 }).toBe(true)
    const stored = fs.readFileSync(transcript, 'utf8')
    expect(stored).toContain('[Phone comment] ')
    expect(stored, 'a token never reaches the agent').not.toMatch(/\/doc\/[A-Za-z0-9_-]{20,}/)
    await shot(phone, 'sent')

    // ← returns to the Dock, then ✕ to the chat as it was
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)
    await expect(phone.getByTestId('phone-dock-panel')).toBeVisible()
    await tap(cdp, phone, phone.getByTestId('phone-dock-close'))
    await expect(phone.getByTestId('phone-dock-panel')).toHaveCount(0)
    await expect(phone.getByTestId('chat-composer')).toHaveValue('half a thought')
})

test('T105 the phone\'s Back walks the same way; a row with no session asks who gets the comment', async () => {
    test.setTimeout(150_000)
    const { app, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't105-back')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await openDock(cdp, phone)

    await tap(cdp, phone, rowBody(phone, 'Orphan page'))
    await expect(phone.getByTestId('phone-doc-frame')).toBeVisible({ timeout: 10_000 })
    await phone.goBack()
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)
    await expect(phone.getByTestId('phone-dock-panel')).toBeVisible()
    await phone.goBack()
    await expect(phone.getByTestId('phone-dock-panel')).toHaveCount(0)

    await openDock(cdp, phone)
    await tap(cdp, phone, rowBody(phone, 'Orphan page'))
    const frame = frameOf(phone)
    await expect(frame.locator('#btn-copy')).toBeVisible({ timeout: 15_000 })
    await frame.locator('textarea:visible').first().fill('who-gets-this')
    await tapInFrame(cdp, phone, frame.locator('#btn-copy'))
    await expect(phone.getByTestId('phone-doc-sheet')).toBeVisible({ timeout: 5_000 })
    await expect(phone.getByTestId('phone-doc-target-select')).toBeVisible({ timeout: 5_000 })
    await expect(phone.getByTestId('phone-doc-send'), 'no session chosen for the person').toBeDisabled()
    await phone.getByTestId('phone-doc-target-select').selectOption(CLAUDE)
    await expect(phone.getByTestId('phone-doc-send')).toBeEnabled({ timeout: 3_000 })
    await tap(cdp, phone, phone.getByTestId('phone-doc-cancel'))
    await expect(phone.getByTestId('phone-doc-sheet')).toHaveCount(0)

    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-dock-panel')).toBeVisible()

    // from the bare list too: the Dock over no session at all
    await phone.goto(`${base}/`)
    await tap(cdp, phone, phone.getByTestId('phone-dock-entry'))
    await expect(phone.getByTestId('phone-dock-row').first()).toBeVisible({ timeout: 10_000 })
    await tap(cdp, phone, rowBody(phone, 'Orphan page'))
    await expect(phone.getByTestId('phone-doc-frame')).toBeVisible({ timeout: 10_000 })
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-dock-panel')).toBeVisible()
    await tap(cdp, phone, phone.getByTestId('phone-dock-close'))
    await expect(phone.getByTestId('phone-sidebar')).toBeVisible()
})

test('T105 a deleted row and a link row open no document', async () => {
    test.setTimeout(120_000)
    const { app, base } = await launch()
    const { phone, cdp } = await openPhone(app, `${base}/?session=${CLAUDE}&view=chat`, 't105-rows')
    await expect(phone.getByTestId('chat-composer')).toBeVisible({ timeout: 15_000 })
    await openDock(cdp, phone)
    await tap(cdp, phone, rowBody(phone, 'Deleted report'))
    await expect(phone.locator('[data-testid="phone-dock-row"]:has-text("Deleted report")')).toHaveAttribute('data-expanded', 'true')
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)
    expect((await requestsOf(app, 't105-rows')).filter((line) => line.includes('/api/phone/doc/open'))).toEqual([])
    await expect(rowBody(phone, 'Artifact page')).toHaveAttribute('href', 'https://claude.ai/code/artifact/x')
})

test('T105 a view-only device sees the list and opens nothing', async () => {
    test.setTimeout(120_000)
    const { app, page, base } = await launch()
    const pairing = await page.evaluate(() => window.api.startPhonePairing('watch'))
    const code = pairing.pairing!.code
    const { phone, cdp } = await openPhone(app, `${base}/`, 't105-watch', false)
    await phone.getByTestId('phone-pair-code').fill(code)
    await phone.getByTestId('phone-pair-label').fill('Watcher')
    await phone.getByTestId('phone-pair-submit').click()
    await expect(phone.getByTestId('phone-who')).toContainText('view only', { timeout: 10_000 })
    await tap(cdp, phone, phone.getByTestId('phone-dock-entry'))
    await expect(phone.getByTestId('phone-dock-row').first()).toBeVisible({ timeout: 10_000 })
    await shot(phone, 'watch')

    await tap(cdp, phone, rowBody(phone, 'Session report'))
    await expect(phone.locator('[data-testid="phone-dock-row"]:has-text("Session report")')).toHaveAttribute('data-expanded', 'true')
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)
    await expect(phone.getByTestId('phone-doc-frame')).toHaveCount(0)
    expect((await requestsOf(app, 't105-watch')).filter((line) => line.includes('/api/phone/doc/open'))).toEqual([])
    // and the server says the same to a page that asks anyway
    const key = await phone.locator('[data-testid="phone-dock-row"]:has-text("Session report")').getAttribute('data-key')
    const asked = await phone.evaluate((dock) => fetch('/api/phone/doc/open', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dock }) }).then((r) => r.status), key)
    expect(asked).toBe(403)
})
