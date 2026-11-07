import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T98 — a file the chat names opens over the chat, on a touch phone (CDP 390×844, scale 3), against the real
 * app and phone server (decision 0010). A seeded conversation names a picture, code, Markdown, a video, a
 * missing file and an `.env`.
 *
 * The rule that matters most is the equivalence: every link the phone draws is a path the server grants, because
 * both come from the same functions (chatMentions.ts). The panel must leave the chat exactly as it was — the same
 * DOM node, scroll and draft — and never resize the Mac's terminal.
 *
 * T98_SHOTS=<dir> + T98_LABEL saves captures before the checks, so the old code's «before» comes from the same run.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const AGENT = 't98-claude'
const OTHER = 't98-claude-other'
const CONVERSATION = '00000000-0000-4000-8000-00000000c98a'
const OTHER_CONVERSATION = '00000000-0000-4000-8000-00000000c98b'
const OWNER = 'owner-t98@example.com'
const PORT = 47898
const DPR = 3
const LABEL = process.env.T98_LABEL ?? 'run'
const slug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-')

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

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T98_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

/** What Claude Code writes: a person's message, an answer naming files, a Read call and its result. */
function seedTranscript(file: string, project: string, attachment: string): void {
    let parent: string | null = null
    let counter = 0
    const entry = (type: string, message: unknown): string => {
        const uuid = `10000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`
        const line = JSON.stringify({ type, message, uuid, parentUuid: parent, timestamp: new Date(Date.UTC(2026, 10, 7, 12, counter)).toISOString(), sessionId: 'seed', cwd: project })
        parent = uuid
        return line
    }
    const answer = [
        'Saved the capture to docs/shot.png and the code is in `src/api.ts:42`.',
        '',
        'Notes are in [the readme](README.md), the page is [the report](report.html), the clip is [the demo](demo.mp4).',
        '',
        'Old copy: [gone](gone/missing.txt). Secrets: [env](.env).',
        ...Array.from({ length: 60 }, (_, index) => `\nFiller line ${index} so that the chat has somewhere to scroll.`)
    ].join('\n')
    const lines = [
        entry('user', { role: 'user', content: `what is in this @${attachment} please` }),
        entry('assistant', {
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: path.join(project, 'src/api.ts') } }],
            stop_reason: 'tool_use',
            usage: { input_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 }
        }),
        entry('user', { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: 'export const b = 2' }] }),
        entry('assistant', {
            role: 'assistant',
            model: 'claude-opus-5-5',
            content: [{ type: 'text', text: answer }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 }
        })
    ]
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

async function launch(): Promise<{ app: ElectronApplication; page: Page; base: string; project: string; attachment: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t98-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true })
    fs.mkdirSync(path.join(project, 'src'), { recursive: true })
    fs.mkdirSync(path.join(project, 'climanager-chat', '2026-11-07'), { recursive: true })
    const picture = fs.readFileSync(path.join(REPO_ROOT, 'resources/icon.png'))
    fs.writeFileSync(path.join(project, 'docs/shot.png'), picture)
    const attachment = path.join(project, 'climanager-chat', '2026-11-07', 'photo.png')
    fs.writeFileSync(attachment, picture)
    fs.writeFileSync(path.join(project, 'src/api.ts'), Array.from({ length: 80 }, (_, index) => `export const value${index + 1} = ${index + 1}`).join('\n'))
    fs.writeFileSync(path.join(project, 'README.md'), '# Project notes\n\nThis file has **bold words**.\n\n- one\n- two\n')
    fs.writeFileSync(path.join(project, 'report.html'), '<!doctype html><title>Report</title><p>hello</p>')
    fs.writeFileSync(path.join(project, 'demo.mp4'), Buffer.concat([Buffer.from([0, 0, 0, 32]), Buffer.alloc(4096, 7)]))
    fs.writeFileSync(path.join(project, '.env'), 'API_TOKEN=abc\n')
    const claudeDir = path.join(home, 'claude')
    const folder = path.join(claudeDir, 'projects', slug(project))
    fs.mkdirSync(folder, { recursive: true })
    const transcript = path.join(folder, `${CONVERSATION}.jsonl`)
    seedTranscript(transcript, project, attachment)
    const otherTranscript = path.join(folder, `${OTHER_CONVERSATION}.jsonl`)
    fs.writeFileSync(otherTranscript, '')
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t98',
            name: 'T98 project',
            path: project,
            sessions: [
                { id: AGENT, name: 'T98 Claude', cliSessionId: CONVERSATION, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300 --continue` },
                { id: OTHER, name: 'T98 Other', cliSessionId: OTHER_CONVERSATION, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${otherTranscript} --work-ms 300` }
            ]
        }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, AGENT, 'Claude Code (mock)', 30_000)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, page, base: `http://127.0.0.1:${state.port}`, project, attachment }
}

async function openWindow(app: ElectronApplication, url: string, partition: string, owner: boolean): Promise<Page> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        if (o.owner) {
            jar.webRequest.onBeforeSendHeaders((details, callback) => {
                callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.login, 'X-Forwarded-For': '100.101.102.103' } })
            })
        }
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, owner, login: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    return phone
}

async function openPhone(app: ElectronApplication, base: string, partition: string): Promise<{ phone: Page; cdp: CDPSession }> {
    const phone = await openWindow(app, `${base}/?session=${AGENT}&view=chat`, partition, true)
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    await expect(phone.getByTestId('chat-answer').last()).toContainText('Saved the capture', { timeout: 20_000 })
    return { phone, cdp }
}

async function tapAt(cdp: CDPSession, page: Page, x: number, y: number): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** A finger on the link: scrolled into view, then a real touch at its middle. */
async function tapLink(cdp: CDPSession, page: Page, words: string, testId = 'chat-file-link'): Promise<void> {
    const link = page.getByTestId(testId).filter({ hasText: words }).first()
    await link.scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    const box = (await link.boundingBox())!
    await tapAt(cdp, page, box.x + box.width / 2, box.y + box.height / 2)
}

async function tapTestId(cdp: CDPSession, page: Page, testId: string): Promise<void> {
    const box = (await page.getByTestId(testId).first().boundingBox())!
    await tapAt(cdp, page, box.x + box.width / 2, box.y + box.height / 2)
}

/** A drag across the screen with a real finger. */
async function swipe(cdp: CDPSession, page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
    for (let step = 1; step <= 6; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + ((to.x - from.x) * step) / 6, y: from.y + ((to.y - from.y) * step) / 6 }] })
        await page.waitForTimeout(16)
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

const fileInfo = (phone: Page, sessionId: string, target: string): Promise<{ http: number; body: Record<string, unknown> }> =>
    phone.evaluate(async ({ sessionId, target }) => {
        const response = await fetch(`/api/phone/file?session=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(target)}`)
        return { http: response.status, body: (await response.json()) as Record<string, unknown> }
    }, { sessionId, target })

test('T98 every path the chat links is a path the server grants (the phone and the server use one list)', async () => {
    test.setTimeout(180_000)
    const { app, base, project, attachment } = await launch()
    const { phone } = await openPhone(app, base, 't98-equivalence')
    const chip = phone.getByTestId('chat-attachment-chip').first()
    await chip.scrollIntoViewIfNeeded()
    await shot(phone, 'chat-chip')
    await expect(phone.getByTestId('chat-file-link').first()).toBeVisible()
    expect(await chip.evaluate((el) => el.tagName), 'a chip that opens the file').toBe('BUTTON')
    await phone.getByTestId('chat-work-block').first().locator('.chat-work-head').click()
    await expect(phone.getByTestId('chat-tool').first().getByTestId('chat-tool-open')).toHaveCount(1)
    await shot(phone, 'chat-tool-open')

    const titles = await phone.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="chat-file-link"],[data-testid="chat-attachment-chip"],[data-testid="chat-tool-open"]')).map((el) => el.getAttribute('title')!.replace(/^Open /, ''))
    )
    expect(titles.length).toBeGreaterThanOrEqual(8)
    for (const title of titles) {
        const bare = title.replace(/:\d+$/, '')
        const target = bare.startsWith('/') ? bare : path.join(project, bare)
        const { body } = await fileInfo(phone, AGENT, target)
        expect(body.reason, title).not.toBe('not_mentioned')
    }
    expect((await fileInfo(phone, AGENT, attachment)).body.status).toBe('ok')
    // a path on the same Mac that this chat never named
    const elsewhere = await fileInfo(phone, AGENT, path.join(project, 'docs/never-named.txt'))
    expect(elsewhere.http).toBe(403)
    expect(elsewhere.body.reason).toBe('not_mentioned')
    // the path another session named is not this session's
    expect((await fileInfo(phone, OTHER, path.join(project, 'docs/shot.png'))).body.reason).toBe('not_mentioned')
})

test('T98 a picture and code open in the panel; closing leaves the chat as it was', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    const before = await page.evaluate((id) => window.api.feedbackTerminalContext(id), AGENT)
    const { phone, cdp } = await openPhone(app, base, 't98-panel')
    const composer = phone.getByTestId('chat-composer')
    await composer.fill('half a thought')
    await phone.evaluate(() => {
        ;(window as unknown as { __chatNode: Element }).__chatNode = document.querySelector('[data-testid="chat-answer"]')!
        const scroller = document.querySelector('.chat-scroll') ?? document.querySelector('[data-testid="chat-scroll"]')
        if (scroller) scroller.scrollTop = 40
    })
    await tapLink(cdp, phone, 'docs/shot.png')
    const panel = phone.getByTestId('phone-file-panel')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    const image = panel.getByTestId('phone-file-image')
    await expect.poll(() => image.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0)
    await expect(panel.getByTestId('phone-file-name')).toHaveText('shot.png')
    await shot(phone, 'panel-image')

    const scrollBefore = await phone.evaluate(() => {
        const answer = document.querySelector('[data-testid="chat-answer"]')!
        let scroller: Element | null = answer
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
        return scroller?.scrollTop ?? -1
    })

    // ←: back through the history entry the panel added
    await tapTestId(cdp, phone, 'phone-file-close')
    await expect(panel).toHaveCount(0)
    await expect(composer).toHaveValue('half a thought')
    expect(await phone.evaluate(() => (window as unknown as { __chatNode: Element }).__chatNode === document.querySelector('[data-testid="chat-answer"]')), 'the same chat, not a new one').toBe(true)
    const scrollAfter = await phone.evaluate(() => {
        const answer = document.querySelector('[data-testid="chat-answer"]')!
        let scroller: Element | null = answer
        while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
        return scroller?.scrollTop ?? -1
    })
    expect(scrollAfter).toBe(scrollBefore)
    expect(phone.url()).toContain(`session=${AGENT}`)
    expect(phone.url()).not.toContain('shot.png')

    // `:42`: the code opens on that line, marked
    await tapLink(cdp, phone, 'src/api.ts:42')
    await expect(panel).toBeVisible({ timeout: 10_000 })
    const line = panel.locator('.hl-line.is-target')
    await expect(line).toContainText('value42', { timeout: 10_000 })
    await expect.poll(() => line.evaluate((el) => {
        const box = el.getBoundingClientRect()
        return box.top >= 0 && box.bottom <= window.innerHeight
    })).toBe(true)
    await shot(phone, 'panel-code')

    // the phone's Back: only the panel closes
    await phone.goBack()
    await expect(panel).toHaveCount(0)
    await expect(phone.getByTestId('phone-session')).toBeVisible()
    await expect(composer).toHaveValue('half a thought')

    // the tool row's ↗ and the attachment chip open the same panel
    await phone.getByTestId('chat-work-block').first().locator('.chat-work-head').click()
    await phone.getByTestId('chat-tool-open').first().scrollIntoViewIfNeeded()
    await tapTestId(cdp, phone, 'chat-tool-open')
    await expect(panel.getByTestId('phone-file-name')).toHaveText('api.ts', { timeout: 10_000 })
    await phone.goBack()
    await phone.getByTestId('chat-attachment-chip').first().scrollIntoViewIfNeeded()
    await tapTestId(cdp, phone, 'chat-attachment-chip')
    await expect(panel.getByTestId('phone-file-name')).toHaveText('photo.png', { timeout: 10_000 })
    await phone.goBack()

    // the Mac's terminal was never resized by any of it
    const after = await page.evaluate((id) => window.api.feedbackTerminalContext(id), AGENT)
    expect(after.terminal?.size).toEqual(before.terminal?.size)
    const events = (after.terminal?.events ?? []) as { kind: string; detail?: string }[]
    const earlier = ((before.terminal?.events ?? []) as { kind: string }[]).filter((e) => e.kind === 'resized').length
    expect(events.filter((e) => e.kind === 'resized').length).toBe(earlier)
    // what was opened is in the session's log — the kind and size, never the path
    const logged = events.filter((e) => e.kind === 'phone-file').map((e) => e.detail ?? '')
    expect(logged.length).toBeGreaterThan(0)
    expect(logged.join(' ')).not.toContain('shot.png')
    expect(logged.join(' ')).not.toContain('/')
})

test('T98 Markdown reads as a document with its source a tap away; a video downloads; refusals say why', async () => {
    test.setTimeout(180_000)
    const { app, base, project } = await launch()
    const { phone, cdp } = await openPhone(app, base, 't98-kinds')
    const panel = phone.getByTestId('phone-file-panel')

    await tapLink(cdp, phone, 'the readme')
    await expect(panel.locator('.chat-md strong')).toHaveText('bold words', { timeout: 10_000 })
    await shot(phone, 'panel-markdown')
    await tapTestId(cdp, phone, 'phone-file-source')
    await expect(panel.locator('.hl-code')).toContainText('**bold words**')
    await tapTestId(cdp, phone, 'phone-file-rendered')
    await expect(panel.locator('.chat-md strong')).toHaveText('bold words')
    await phone.goBack()

    // HTML is code until the document view (D3) fills its place
    await tapLink(cdp, phone, 'the report')
    await expect(panel.locator('.hl-code')).toContainText('<title>Report</title>', { timeout: 10_000 })
    await phone.goBack()

    await tapLink(cdp, phone, 'the demo')
    const download = panel.getByTestId('phone-file-download')
    await expect(download).toBeVisible({ timeout: 10_000 })
    await shot(phone, 'panel-download')
    const href = (await download.getAttribute('href'))!
    expect(href).toContain('download=1')
    const raw = await phone.evaluate(async (url) => {
        const response = await fetch(url)
        const headers: Record<string, string> = {}
        response.headers.forEach((value, name) => {
            headers[name] = value
        })
        return { status: response.status, headers, size: (await response.arrayBuffer()).byteLength }
    }, href)
    expect(raw.status).toBe(200)
    expect(raw.size).toBe(4100)
    expect(raw.headers['content-disposition']).toContain('attachment')
    expect(raw.headers['content-security-policy']).toContain('sandbox')
    expect(raw.headers['cross-origin-resource-policy']).toBe('same-origin')
    expect(raw.headers['cache-control']).toBe('no-store')
    await phone.goBack()

    await tapLink(cdp, phone, 'gone')
    await expect(panel.getByTestId('phone-file-refused')).toHaveAttribute('data-reason', 'not_found', { timeout: 10_000 })
    await expect(panel.getByTestId('phone-file-refused')).toContainText('Not on the Mac')
    await expect(panel.getByTestId('phone-file-refused')).toContainText('gone/missing.txt')
    await shot(phone, 'panel-missing')
    await phone.goBack()

    await tapLink(cdp, phone, 'env')
    await expect(panel.getByTestId('phone-file-refused')).toHaveAttribute('data-reason', 'protected', { timeout: 10_000 })
    await expect(panel.getByTestId('phone-file-refused')).toContainText('Protected')
    await expect(panel).not.toContainText('API_TOKEN')
    await shot(phone, 'panel-protected')
    await phone.goBack()
    expect((await fileInfo(phone, AGENT, path.join(project, '.env'))).http).toBe(403)
})

test('T98 the drawer swipe stays out of the panel; another session closes it; the Mac going away offers Retry', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, 't98-swipe')
    const panel = phone.getByTestId('phone-file-panel')
    await tapLink(cdp, phone, 'src/api.ts:42')
    await expect(panel.locator('.hl-code')).toBeVisible({ timeout: 10_000 })

    // the left edge: PhoneApp's drawer swipe starts here on the chat, not on the panel
    await swipe(cdp, phone, { x: 4, y: 400 }, { x: 180, y: 402 })
    await phone.waitForTimeout(200)
    await expect(phone.getByTestId('phone-app')).toHaveAttribute('data-drawer', 'closed')
    await expect(panel).toBeVisible()

    // a page that moved to another session (an alert tapped) does not keep this session's file open
    await phone.evaluate((session) => {
        window.history.pushState(null, '', `/?session=${session}&view=chat`)
        window.dispatchEvent(new PopStateEvent('popstate'))
    }, OTHER)
    await expect(phone.getByTestId('phone-session')).toHaveAttribute('data-session-id', OTHER, { timeout: 10_000 })
    await expect(panel).toHaveCount(0)
    await phone.goBack()
    await expect(phone.getByTestId('phone-session')).toHaveAttribute('data-session-id', AGENT, { timeout: 10_000 })
    await expect(panel).toHaveCount(0)

    // the Mac stops answering: said once, with Retry, and Retry works when it is back
    await expect(phone.getByTestId('chat-file-link').first()).toBeVisible({ timeout: 15_000 })
    await page.evaluate(() => window.api.setPhoneEnabled(false))
    await tapLink(cdp, phone, 'docs/shot.png')
    const offline = panel.getByTestId('phone-file-offline')
    await expect(offline).toContainText('The Mac is not answering', { timeout: 15_000 })
    await shot(phone, 'panel-offline')
    await page.evaluate(() => window.api.setPhoneEnabled(true))
    await tapTestId(cdp, phone, 'phone-file-retry')
    await expect(panel.getByTestId('phone-file-image')).toBeVisible({ timeout: 15_000 })
})

test('T98 a view-only device sees no links and the server refuses it', async () => {
    test.setTimeout(180_000)
    const { app, page, base, project } = await launch()
    const state = await page.evaluate(() => window.api.startPhonePairing('watch'))
    const code = state.pairing!.code
    const phone = await openWindow(app, `${base}/?session=${AGENT}&view=chat`, 't98-watch', false)
    await phone.getByTestId('phone-pair-code').fill(code)
    await phone.getByTestId('phone-pair-submit').click()
    await expect(phone.getByTestId('chat-answer').last()).toContainText('Saved the capture', { timeout: 20_000 })
    await expect(phone.getByTestId('chat-file-link')).toHaveCount(0)
    await expect(phone.getByTestId('chat-tool-open')).toHaveCount(0)
    expect(await phone.getByTestId('chat-attachment-chip').first().evaluate((el) => el.tagName)).toBe('SPAN')
    const refused = await fileInfo(phone, AGENT, path.join(project, 'docs/shot.png'))
    expect(refused.http).toBe(403)
    expect(refused.body.reason).toBe('view_only')
    await shot(phone, 'watch-no-links')
    expect(await phone.evaluate(async (url) => (await fetch(url)).status, `/api/phone/file/raw?session=${AGENT}&path=${encodeURIComponent(path.join(project, 'docs/shot.png'))}`)).toBe(403)
})
