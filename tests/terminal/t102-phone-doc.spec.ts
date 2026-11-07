import { test, expect, type CDPSession, type ElectronApplication, type Frame, type FrameLocator, type Locator, type Page } from '@playwright/test'
import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T102 — a report the chat names opens in a sandboxed frame, and its comments reach the session only when the person
 * presses Send in the phone page's own sheet (decision 0011). Real app, real phone server, a touch phone (CDP 390×844,
 * scale 3). The kit pages in tests/fixtures/phone-doc were produced by the kits' own scripts (see SOURCE.md there).
 *
 * The rule that matters most: what the frame's code tries is judged where it lands. A request that reaches the server is
 * seen by main's session hook (`webRequest`), so "blocked" here means it never left the browser, not that it was answered
 * with an error. A control request from the phone page itself proves the hook sees requests at all.
 *
 * T102_SHOTS=<dir> + T102_LABEL save captures before the checks, so the old code's «before» comes from the same run.
 * T102_WEBKIT_CORE=<path to a playwright-core with its WebKit installed> also runs the frame in WebKit: its cookies differ.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const FIXTURES = path.join(REPO_ROOT, 'tests/fixtures/phone-doc')
const AGENT = 't102-claude'
/** a session link names ids by their hex: this one is opened from the sheet's notice */
const OTHER = 'abcdef01-0000-4000-8000-000000000102'
const SLOW = 't102-claude-slow'
const CONVERSATION = '00000000-0000-4000-8000-00000000d102'
const OTHER_CONVERSATION = '00000000-0000-4000-8000-00000000d103'
const SLOW_CONVERSATION = '00000000-0000-4000-8000-00000000d104'
const OWNER = 'owner-t102@example.com'
const PORT = 47902
const DPR = 3
const LABEL = process.env.T102_LABEL ?? 'run'
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
    const dir = process.env.T102_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

const LINKS = [
    'The reports: [the eli5 report](review/eli5.html), [the before after](review/ba.html), [the feedback kit](review/hfk/hfk.html).',
    '',
    '[the probe page](review/probe.html), [the missing page](review/missing.html), [the font page](review/font.html), [the plain page](review/plain.html).',
    '',
    'Code view at a line: `review/plain.html:1`. Picture: [the picture](review/a.png).'
].join('\n')

function seedTranscript(file: string, answer: string): void {
    const entry = (type: string, message: unknown, counter: number): string =>
        JSON.stringify({
            type,
            message,
            uuid: `10000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
            parentUuid: counter > 1 ? `10000000-0000-4000-8000-${String(counter - 1).padStart(12, '0')}` : null,
            timestamp: new Date(Date.UTC(2026, 10, 7, 12, counter)).toISOString(),
            sessionId: path.basename(file, '.jsonl'),
            cwd: path.dirname(file)
        })
    const lines = [
        entry('user', { role: 'user', content: 'make the reports' }, 1),
        entry('assistant', { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: answer }], stop_reason: 'end_turn', usage: { input_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 1, output_tokens: 1 } }, 2)
    ]
    fs.writeFileSync(file, `${lines.join('\n')}\n`)
}

/** What the frame's own code tries. Every URL carries `probe=` so main's hook can tell these from the page's polling. */
const PROBE_PAGE = (sessionId: string): string => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>Probe</title>
<script src="/api/phone/sessions?probe=script"></script>
<link rel="stylesheet" href="/api/phone/sessions?probe=css">
</head><body><h1>probe</h1><img id="rel" src="a.png"><img src="/api/phone/sessions?probe=img"><img id="out" src="http://127.0.0.1:47999/probe=outside.png">
<script>
(async function () {
    var R = {}
    var t = async function (name, run) { try { R[name] = await run() } catch (e) { R[name] = 'THROW ' + (e && e.name) } }
    var send = '/api/phone/chat/${sessionId}/send'
    await t('origin', function () { return self.origin })
    await t('secure', function () { return self.isSecureContext })
    await t('parentDom', function () { return parent.document.title })
    await t('topLocation', function () { return top.location.href })
    await t('fetchGet', function () { return fetch('/api/phone/sessions?probe=get', { credentials: 'include' }).then(function (r) { return r.text() }).then(function (x) { return 'READ ' + x.slice(0, 20) }) })
    await t('fetchNoCors', function () { return fetch('/api/phone/sessions?probe=nocors', { mode: 'no-cors', credentials: 'include' }).then(function (r) { return 'type=' + r.type }) })
    await t('fetchPost', function () { return fetch(send + '?probe=post', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: '{"text":"PROBE-FETCH"}' }).then(function (r) { return 'status ' + r.status }) })
    await t('fetchPostNoCors', function () { return fetch(send + '?probe=postnocors', { method: 'POST', mode: 'no-cors', credentials: 'include', body: '{"text":"PROBE-NOCORS"}' }).then(function (r) { return 'type=' + r.type }) })
    await t('beacon', function () { return navigator.sendBeacon(send + '?probe=beacon', '{"text":"PROBE-BEACON"}') })
    await t('xhr', function () { return new Promise(function (ok) { var x = new XMLHttpRequest(); x.open('GET', '/api/phone/sessions?probe=xhr'); x.onload = function () { ok('READ') }; x.onerror = function () { ok('error') }; x.send() }) })
    await t('socket', function () { return new Promise(function (ok) { var w = new WebSocket('ws://' + location.host + '/api/phone/terminal?session=${sessionId}&probe=ws'); w.onopen = function () { ok('OPEN') }; w.onerror = function () { ok('error') }; setTimeout(function () { ok('timeout') }, 1500) }) })
    await t('popup', function () { return String(!!window.open('http://127.0.0.1:47999/probe=popup')) })
    await t('form', function () { var f = document.createElement('form'); f.action = send + '?probe=form'; f.method = 'POST'; var i = document.createElement('input'); i.name = 'text'; i.value = 'PROBE-FORM'; f.appendChild(i); document.body.appendChild(f); f.submit(); return 'submitted' })
    await new Promise(function (r) { setTimeout(r, 600) })
    var img = function (id) { var e = document.getElementById(id); return e.complete && e.naturalWidth > 0 ? 'loaded' : 'failed' }
    R.imgNextTo = img('rel')
    R.imgOutside = img('out')
    await t('canvasRead', function () { var c = document.createElement('canvas'); c.width = c.height = 1; var g = c.getContext('2d'); g.drawImage(document.getElementById('rel'), 0, 0); return 'READ ' + g.getImageData(0, 0, 1, 1).data[0] })
    parent.postMessage({ type: 'probe', R: R }, '*')
})()
</script></body></html>`

interface Launched {
    app: ElectronApplication
    page: Page
    base: string
    project: string
    transcript: string
    slowTranscript: string
}

async function launch(): Promise<Launched> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t102-'))
    const project = path.join(home, 'project')
    const review = path.join(project, 'review')
    fs.mkdirSync(project, { recursive: true })
    fs.cpSync(FIXTURES, review, { recursive: true })
    fs.writeFileSync(path.join(review, '.env'), 'API_TOKEN=abc\n')
    fs.writeFileSync(path.join(review, 'probe.html'), PROBE_PAGE(AGENT))
    fs.writeFileSync(path.join(project, 'outside.png'), fs.readFileSync(path.join(FIXTURES, 'a.png')))
    fs.writeFileSync(path.join(review, 'missing.html'), '<!doctype html><title>Missing</title><img src="../outside.png"><img src="http://127.0.0.1:47999/x.png"><img id="here" src="a.png"><p>words</p>')
    fs.copyFileSync(path.join(REPO_ROOT, 'src/renderer/src/phone/fonts/clim-phone-mono-ksx1001.woff2'), path.join(review, 'mono.woff2'))
    fs.writeFileSync(path.join(review, 'font.html'), '<!doctype html><title>Font</title><style>@font-face{font-family:T102;src:url(mono.woff2)}body{font-family:T102}</style><script type="module" src="mod.js"></script><p>가나다</p>')
    fs.writeFileSync(path.join(review, 'mod.js'), 'window.__t102Module = 1\n')
    fs.writeFileSync(path.join(review, 'plain.html'), '<!doctype html><html lang="ko"><title>Plain page</title><p id="words">hello from the page</p></html>')
    const claudeDir = path.join(home, 'claude')
    const folder = path.join(claudeDir, 'projects', slug(project))
    fs.mkdirSync(folder, { recursive: true })
    const transcript = path.join(folder, `${CONVERSATION}.jsonl`)
    const answer = [LINKS, ...Array.from({ length: 40 }, (_, index) => `\nFiller line ${index} so that the chat has somewhere to scroll.`)].join('\n')
    seedTranscript(transcript, answer)
    const otherTranscript = path.join(folder, `${OTHER_CONVERSATION}.jsonl`)
    fs.writeFileSync(otherTranscript, '')
    const slowTranscript = path.join(folder, `${SLOW_CONVERSATION}.jsonl`)
    seedTranscript(slowTranscript, LINKS)
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{
            id: 'w-t102',
            name: 'T102 project',
            path: project,
            sessions: [
                { id: AGENT, name: 'T102 Claude', cliSessionId: CONVERSATION, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --work-ms 300 --continue` },
                { id: OTHER, name: 'T102 Other', cliSessionId: OTHER_CONVERSATION, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${otherTranscript} --work-ms 300` },
                { id: SLOW, name: 'T102 Slow', cliSessionId: SLOW_CONVERSATION, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${slowTranscript} --work-ms 6000 --continue` }
            ]
        }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLAUDE_CONFIG_DIR: claudeDir } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await waitForBufferText(page, AGENT, 'Claude Code (mock)', 30_000)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, page, base: `http://127.0.0.1:${state.port}`, project, transcript, slowTranscript }
}

/** A phone window with serve's owner headers. Main records every request that leaves it. */
async function openWindow(app: ElectronApplication, url: string, partition: string): Promise<Page> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition(o.partition)
        const seen: string[] = []
        ;(globalThis as Record<string, unknown>)[`requests:${o.partition}`] = seen
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            seen.push(`${details.method} ${details.url}`)
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.login, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: o.partition, backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, partition, login: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    return phone
}

const requestsOf = (app: ElectronApplication, partition: string): Promise<string[]> =>
    app.evaluate((_electron, name) => (globalThis as unknown as Record<string, string[]>)[`requests:${name}`] ?? [], partition)

async function openPhone(app: ElectronApplication, base: string, partition: string, sessionId = AGENT): Promise<{ phone: Page; cdp: CDPSession }> {
    const phone = await openWindow(app, `${base}/?session=${sessionId}&view=chat`, partition)
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    await expect(phone.getByTestId('chat-answer').last()).toContainText('The reports', { timeout: 20_000 })
    return { phone, cdp }
}

async function tapAt(cdp: CDPSession, page: Page, x: number, y: number): Promise<void> {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

/** A finger on it: scrolled into view, then a real touch at its middle. Frame contents report page coordinates. */
async function tap(cdp: CDPSession, page: Page, target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    const box = (await target.boundingBox())!
    await tapAt(cdp, page, box.x + box.width / 2, box.y + box.height / 2)
}

/**
 * A finger inside the frame. The frame is its own process, and `Input.dispatchTouchEvent` makes no tap there: the page gets
 * touchstart and touchend but no click, which is the harness, not the page (measured; a phone's own touch goes through the
 * browser's gesture recogniser). This goes through that recogniser. Still browser input, not a DOM event; the real finger
 * is on device-todo.md.
 */
async function tapInFrame(cdp: CDPSession, page: Page, target: Locator): Promise<void> {
    await target.scrollIntoViewIfNeeded()
    await page.waitForTimeout(150)
    const box = (await target.boundingBox())!
    await cdp.send('Input.synthesizeTapGesture', { x: box.x + box.width / 2, y: box.y + box.height / 2 })
}

const chatLink = (page: Page, words: string): Locator => page.getByTestId('chat-file-link').filter({ hasText: words }).first()
const frameOf = (page: Page): FrameLocator => page.frameLocator('[data-testid="phone-doc-frame"]')

function docFrame(page: Page): Frame {
    const frame = page.frames().find((candidate) => candidate.url().includes('/doc/'))
    if (!frame) throw new Error('no document frame')
    return frame
}

async function openDoc(cdp: CDPSession, phone: Page, words: string): Promise<FrameLocator> {
    await tap(cdp, phone, chatLink(phone, words))
    await expect(phone.getByTestId('phone-doc-frame')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => phone.frames().some((frame) => frame.url().includes('/doc/')), { timeout: 10_000 }).toBe(true)
    return frameOf(phone)
}

async function eventsOf(page: Page, id: string): Promise<{ kind: string; detail?: string }[]> {
    const context = await page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId), id)
    return (context.terminal?.events ?? []) as { kind: string; detail?: string }[]
}

async function waitArmed(phone: Page): Promise<void> {
    await expect(phone.getByTestId('phone-doc-send')).toBeEnabled({ timeout: 3_000 })
}

test('T102 a report opens in a sandboxed frame; closing leaves the chat as it was', async () => {
    test.setTimeout(180_000)
    const { app, page, base } = await launch()
    const before = await eventsOf(page, AGENT)
    const { phone, cdp } = await openPhone(app, base, 't102-open')
    await shot(phone, 'chat')
    const composer = phone.getByTestId('chat-composer')
    await composer.fill('a draft that must survive')
    await chatLink(phone, 'the eli5 report').scrollIntoViewIfNeeded()
    const scrollTop = (): Promise<number> =>
        phone.evaluate(() => {
            let scroller: Element | null = document.querySelector('[data-testid="chat-answer"]')
            while (scroller && scroller.scrollHeight <= scroller.clientHeight) scroller = scroller.parentElement
            return scroller?.scrollTop ?? -1
        })
    const scrollBefore = await scrollTop()
    await phone.evaluate(() => {
        ;(window as unknown as { __chatNode: Element | null }).__chatNode = document.querySelector('[data-testid="chat-answer"]')
    })

    await tap(cdp, phone, chatLink(phone, 'the eli5 report'))
    await phone.waitForTimeout(800)
    await shot(phone, 'report-open')

    // what the old code does: the HTML's source. What this asks: the page itself
    const element = phone.getByTestId('phone-doc-frame')
    await expect(element).toBeVisible({ timeout: 10_000 })
    expect(await element.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals')
    await expect(phone.getByTestId('phone-doc-name')).toHaveText('eli5 fixture')
    await expect.poll(() => phone.frames().some((frame) => frame.url().includes('/doc/'))).toBe(true)
    const frame = docFrame(phone)
    expect(await frame.evaluate(() => self.origin)).toBe('null')
    expect(new URL(frame.url()).pathname, 'the address names a token, not the Mac path').toMatch(/^\/doc\/[A-Za-z0-9_-]{32,}\/eli5\.html$/)
    // the picture beside it comes through the token: a sandboxed page's requests carry no cookie in Chromium
    await expect.poll(() => frame.evaluate(() => Array.from(document.images).every((image) => image.complete && image.naturalWidth > 0))).toBe(true)
    // the phone's address did not get the path or the token
    expect(phone.url()).not.toContain('eli5')

    // a link inside the page: no extra stop for ← to go through
    await tapInFrame(cdp, phone, frameOf(phone).locator('#hash'))
    await phone.waitForTimeout(200)
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0, { timeout: 3_000 })
    await expect(composer).toHaveValue('a draft that must survive')
    expect(await scrollTop()).toBe(scrollBefore)
    expect(await phone.evaluate(() => (window as unknown as { __chatNode: Element | null }).__chatNode === document.querySelector('[data-testid="chat-answer"]')), 'the same chat, not a new one').toBe(true)

    // phone Back closes it too
    await tap(cdp, phone, chatLink(phone, 'the plain page'))
    await expect(phone.getByTestId('phone-doc-frame')).toBeVisible({ timeout: 10_000 })
    await phone.goBack()
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)

    // a line asked for is a place in the source: the code view, as before
    await tap(cdp, phone, phone.getByTestId('chat-file-link').filter({ hasText: 'plain.html:1' }).first())
    await expect(phone.getByTestId('phone-file-panel').locator('.hl-code')).toContainText('Plain page', { timeout: 10_000 })
    await phone.goBack()

    const after = await eventsOf(page, AGENT)
    expect(after.filter((e) => e.kind === 'resized').length, 'the Mac terminal is never resized').toBe(before.filter((e) => e.kind === 'resized').length)
    expect(after.some((e) => e.kind === 'phone-file' && /^document opened \(html, /.test(e.detail ?? ''))).toBe(true)
    expect(after.filter((e) => e.kind === 'phone-file').map((e) => e.detail ?? '').join(' '), 'the log has no paths').not.toContain('review')
})

test('T102 the frame code reaches nothing: no API, no socket, no other host, not even opened on its own', async () => {
    test.setTimeout(180_000)
    const { app, page, base, transcript } = await launch()
    const partition = 't102-probe'
    const { phone, cdp } = await openPhone(app, base, partition)
    await phone.evaluate(() => {
        window.addEventListener('message', (event) => {
            const data = event.data as { type?: string; R?: unknown }
            if (data?.type === 'probe') (window as unknown as { __probe: unknown }).__probe = data.R
        })
    })
    const transcriptBefore = fs.readFileSync(transcript, 'utf8')
    // the control: the same hook sees a request from the phone page itself
    await phone.evaluate(() => fetch('/api/phone/sessions?probe=control').then((r) => r.status))
    expect((await requestsOf(app, partition)).some((line) => line.includes('probe=control')), 'the hook sees requests').toBe(true)

    await tap(cdp, phone, chatLink(phone, 'the probe page'))
    await expect(phone.getByTestId('phone-doc-frame')).toBeVisible({ timeout: 10_000 })
    await expect.poll(() => phone.evaluate(() => (window as unknown as { __probe: unknown }).__probe ?? null), { timeout: 20_000 }).not.toBeNull()
    const probe = (await phone.evaluate(() => (window as unknown as { __probe: unknown }).__probe)) as Record<string, unknown>

    expect(probe.origin).toBe('null')
    expect(probe.parentDom).toBe('THROW SecurityError')
    expect(probe.topLocation).toBe('THROW SecurityError')
    expect(probe.fetchGet).toBe('THROW TypeError')
    expect(probe.fetchNoCors).toBe('THROW TypeError')
    expect(probe.fetchPost).toBe('THROW TypeError')
    expect(probe.fetchPostNoCors).toBe('THROW TypeError')
    expect(probe.xhr).toBe('error')
    expect(probe.socket).toBe('error')
    expect(probe.popup).toBe('false')
    expect(probe.imgNextTo).toBe('loaded')
    expect(probe.imgOutside).toBe('failed')
    expect(probe.canvasRead).toBe('THROW SecurityError')

    await phone.waitForTimeout(500)
    const reached = (await requestsOf(app, partition)).filter((line) => line.includes('probe=') && !line.includes('probe=control'))
    expect(reached, 'nothing the frame tried left the browser').toEqual([])
    expect(fs.readFileSync(transcript, 'utf8'), 'nothing reached the session').toBe(transcriptBefore)
    expect((await eventsOf(page, AGENT)).filter((e) => e.kind === 'phone-input')).toEqual([])

    // the token address on its own, as a top-level page: still sandboxed
    const tokenUrl = docFrame(phone).url()
    const alone = await openWindow(app, tokenUrl, `${partition}-alone`)
    await alone.waitForLoadState('domcontentloaded')
    expect(await alone.evaluate(() => self.origin)).toBe('null')
    expect(await alone.evaluate(() => fetch('/api/phone/sessions').then(() => 'READ').catch((e: Error) => e.name))).toBe('TypeError')
    await alone.close()
})

test('T102 each kit: a comment becomes the sheet, and only Send puts it in the session', async () => {
    test.setTimeout(300_000)
    const { app, page, base, transcript } = await launch()
    const { phone, cdp } = await openPhone(app, base, 't102-kits')
    const untouched = (): void => {
        expect(fs.readFileSync(transcript, 'utf8')).not.toContain('Phone comment')
    }

    const sendAndCheck = async (words: string[], forbidden: string[] = []): Promise<void> => {
        const send = phone.getByTestId('phone-doc-send')
        await expect(phone.getByTestId('phone-doc-sheet')).toBeVisible({ timeout: 5_000 })
        await waitArmed(phone)
        const text = (await phone.getByTestId('phone-doc-text').textContent()) ?? ''
        for (const word of words) expect(text).toContain(word)
        await tap(cdp, phone, send)
        await expect(phone.getByTestId('phone-doc-sheet')).toHaveCount(0, { timeout: 15_000 })
        await expect(phone.getByTestId('phone-doc-notice')).toBeVisible()
        await expect.poll(() => fs.readFileSync(transcript, 'utf8').includes(words[words.length - 1]), { timeout: 15_000 }).toBe(true)
        const stored = fs.readFileSync(transcript, 'utf8')
        for (const word of forbidden) expect(stored).not.toContain(word)
        expect(stored, 'a token never reaches the agent').not.toMatch(/\/doc\/[A-Za-z0-9_-]{20,}/)
        await phone.waitForTimeout(900)
    }

    // eli5 — add-feedback.mjs, relabelled by the bridge
    let frame = await openDoc(cdp, phone, 'the eli5 report')
    await tapInFrame(cdp, phone, frame.locator('.eli5-fb-btn').first())
    await frame.locator('#eli5-fb-ta-0').fill('eli5-comment-words')
    await expect(frame.locator('#eli5-fb-copy')).toHaveText('Send to session')
    await shot(phone, 'eli5-comment')
    await tapInFrame(cdp, phone, frame.locator('#eli5-fb-copy'))
    await expect(phone.getByTestId('phone-doc-sheet')).toBeVisible({ timeout: 5_000 })
    await shot(phone, 'sheet')
    // the sheet holds the frame still, and a finger that opened it cannot press Send by staying put
    expect(await phone.getByTestId('phone-doc-send').isDisabled(), 'Send is not armed at once').toBe(true)
    expect(await phone.getByTestId('phone-doc-frame').evaluate((el) => el.hasAttribute('inert'))).toBe(true)
    untouched()
    expect((await eventsOf(page, AGENT)).filter((e) => e.kind === 'phone-input')).toEqual([])
    // a page changing its words while the person reads them: not taken
    await docFrame(phone).evaluate(() => parent.postMessage({ type: 'doc-comment', text: 'SWAPPED-WORDS', via: 'clipboard' }, '*'))
    await phone.waitForTimeout(200)
    expect(await phone.getByTestId('phone-doc-text').textContent()).not.toContain('SWAPPED-WORDS')
    expect(await phone.getByTestId('phone-doc-target').textContent()).toContain('T102 Claude')
    await sendAndCheck(['[Phone comment] ', 'review/eli5.html', 'eli5-comment-words'], ['SWAPPED-WORDS'])
    await shot(phone, 'sent')
    expect((await eventsOf(page, AGENT)).some((e) => e.kind === 'phone-input' && /^chat message /.test(e.detail ?? ''))).toBe(true)

    // the same kit's «save as file» goes the same way
    await tapInFrame(cdp, phone, frame.locator('#eli5-fb-save'))
    await expect(phone.getByTestId('phone-doc-sheet')).toBeVisible({ timeout: 5_000 })
    await expect(phone.getByTestId('phone-doc-text')).toContainText('eli5-comment-words')
    await tap(cdp, phone, phone.getByTestId('phone-doc-cancel'))
    await expect(phone.getByTestId('phone-doc-sheet')).toHaveCount(0)
    await expect(phone.getByTestId('phone-doc-frame')).not.toHaveAttribute('inert', '')

    // what was written stays on this phone: closed and opened again (the fragment seed)
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)
    frame = await openDoc(cdp, phone, 'the eli5 report')
    await tapInFrame(cdp, phone, frame.locator('.eli5-fb-btn').first())
    await expect(frame.locator('#eli5-fb-ta-0')).toHaveValue('eli5-comment-words')
    expect(await docFrame(phone).evaluate(() => location.hash), 'the seed does not stay in the frame address').toBe('')
    // a page's confirm() works: the kit's «clear» (allow-modals)
    phone.once('dialog', (dialog) => void dialog.accept())
    await tapInFrame(cdp, phone, frame.locator('#eli5-fb-clear'))
    await expect(frame.locator('#eli5-fb-ta-0')).toHaveValue('')
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)

    // html-feedback-kit — its own Copy, JSON save and «send»; the source field must not carry the token
    frame = await openDoc(cdp, phone, 'the feedback kit')
    await expect.poll(() => docFrame(phone).evaluate(async () => {
        const images = Array.from(document.images).slice(0, 3)
        for (const image of images) {
            image.scrollIntoView()
            await new Promise((resolve) => setTimeout(resolve, 150))
        }
        return images.length > 0 && images.every((image) => image.naturalWidth > 0)
    }), { timeout: 10_000 }).toBe(true)
    await frame.locator('#hfk-general').fill('hfk-comment-words')
    await tapInFrame(cdp, phone, frame.locator('#hfk-copy'))
    await sendAndCheck(['"kind": "html-feedback"', 'hfk-comment-words'])
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)

    // before-after — its copy button, without its «go to the terminal and paste» guide; then the pin widget it carries
    frame = await openDoc(cdp, phone, 'the before after')
    await expect(frame.locator('#btn-copy')).toBeVisible({ timeout: 10_000 })
    const comment = frame.locator('textarea:visible').first()
    await comment.fill('ba-comment-words')
    await tapInFrame(cdp, phone, frame.locator('#btn-copy'))
    await expect(phone.getByTestId('phone-doc-sheet')).toBeVisible({ timeout: 5_000 })
    await expect(frame.locator('#guide')).not.toHaveClass(/\bon\b/)
    await sendAndCheck(['ba-comment-words'])

    await frame.locator('#pf-mode').click({ force: true })
    await frame.locator('h1,h2').first().click({ force: true })
    await expect.poll(() => docFrame(phone).evaluate(() => (document.getElementById('pf-editor') as HTMLDialogElement).open)).toBe(true)
    await frame.locator('#pf-text').fill('throwaway words')
    // the widget's «close» is a form method=dialog: dead in a sandbox without allow-forms (Chromium, measured)
    await frame.locator('#pf-editor button[value="cancel"]').click()
    await expect.poll(() => docFrame(phone).evaluate(() => (document.getElementById('pf-editor') as HTMLDialogElement).open)).toBe(false)
    await frame.locator('h1,h2').first().click({ force: true })
    await frame.locator('#pf-text').fill('pin-comment-words')
    await frame.locator('#pf-save').click()
    await frame.locator('#pf-open').click({ force: true })
    await frame.locator('#pf-copy').click({ force: true })
    await sendAndCheck(['pin-comment-words'])
})

test('T102 a refused send keeps the words and says what to do', async () => {
    test.setTimeout(240_000)
    const { app, page, base, slowTranscript } = await launch()
    const { phone, cdp } = await openPhone(app, base, 't102-refused')

    const openSheet = async (): Promise<void> => {
        const frame = frameOf(phone)
        const button = frame.locator('.eli5-fb-btn').first()
        if ((await button.getAttribute('aria-expanded')) !== 'true') await tapInFrame(cdp, phone, button)
        await frame.locator('#eli5-fb-ta-0').fill('refused-comment-words')
        await tapInFrame(cdp, phone, frame.locator('#eli5-fb-copy'))
        await expect(phone.getByTestId('phone-doc-sheet')).toBeVisible({ timeout: 5_000 })
        await waitArmed(phone)
    }

    // text in the Mac's input box: the chat's own note, two presses to clear
    await openDoc(cdp, phone, 'the eli5 report')
    await openSheet()
    await writeToTerminal(page, AGENT, 'left at the mac')
    await waitForBufferText(page, AGENT, '❯ left at the mac', 10_000)
    await tap(cdp, phone, phone.getByTestId('phone-doc-send'))
    await expect(phone.getByTestId('chat-input-busy-draft')).toHaveText('left at the mac', { timeout: 10_000 })
    await shot(phone, 'sheet-input-busy')
    await expect(phone.getByTestId('phone-doc-text')).toContainText('refused-comment-words')
    await tap(cdp, phone, phone.getByTestId('chat-input-busy-clear'))
    await waitForBufferText(page, AGENT, '❯ left at the mac', 2_000)
    await tap(cdp, phone, phone.getByTestId('chat-input-busy-confirm'))
    await expect(phone.getByTestId('phone-doc-sheet')).toHaveCount(0, { timeout: 15_000 })
    await waitForBufferText(page, AGENT, 'ANSWER', 15_000)
    await phone.waitForTimeout(800)

    // a question on the screen: refused, with the way to it
    await writeToTerminal(page, AGENT, 'ASK\r')
    await waitForBufferText(page, AGENT, 'Do you want', 10_000)
    await openSheet()
    await tap(cdp, phone, phone.getByTestId('phone-doc-send'))
    await expect(phone.getByTestId('phone-doc-refusal')).toContainText('asking a question', { timeout: 10_000 })
    await expect(phone.getByTestId('phone-doc-text')).toContainText('refused-comment-words')
    await shot(phone, 'sheet-awaiting')
    await tap(cdp, phone, phone.getByTestId('phone-doc-open-chat'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0, { timeout: 3_000 })
    await expect(phone.getByTestId('chat-prompt-card').first()).toBeVisible({ timeout: 10_000 })

    // the other session: the agent has left. Pick another one; the word goes there
    await phone.close()
    const second = await openPhone(app, base, 't102-gone', SLOW)
    await tap(second.cdp, second.phone, chatLink(second.phone, 'the eli5 report'))
    await expect(second.phone.getByTestId('phone-doc-frame')).toBeVisible({ timeout: 10_000 })
    const frame = frameOf(second.phone)
    await tapInFrame(second.cdp, second.phone, frame.locator('.eli5-fb-btn').first())
    await frame.locator('#eli5-fb-ta-0').fill('queued-comment-words')
    await tapInFrame(second.cdp, second.phone, frame.locator('#eli5-fb-copy'))
    await waitArmed(second.phone)
    // working: it waits for the turn to end, and the sheet says so
    await writeToTerminal(page, SLOW, 'start a slow turn\r')
    await waitForBufferText(page, SLOW, 'ANSWER', 5_000).catch(() => undefined)
    // on its way it cannot be taken back: Cancel says so by not being offered
    await second.phone.route('**/send', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700))
        await route.continue()
    })
    await tap(second.cdp, second.phone, second.phone.getByTestId('phone-doc-send'))
    await expect(second.phone.getByTestId('phone-doc-cancel')).toBeDisabled({ timeout: 500 })
    await expect(second.phone.getByTestId('phone-doc-notice')).toContainText('gets this when the turn ends', { timeout: 10_000 })
    await second.phone.unroute('**/send')
    await shot(second.phone, 'sent-queued')
    await expect.poll(() => fs.readFileSync(slowTranscript, 'utf8').includes('queued-comment-words'), { timeout: 30_000 }).toBe(true)

    await writeToTerminal(page, SLOW, '\x03')
    await second.phone.waitForTimeout(1500)
    await tapInFrame(second.cdp, second.phone, frame.locator('#eli5-fb-copy'))
    await waitArmed(second.phone)
    await tap(second.cdp, second.phone, second.phone.getByTestId('phone-doc-send'))
    await expect(second.phone.getByTestId('phone-doc-refusal')).toBeVisible({ timeout: 10_000 })
    const select = second.phone.getByTestId('phone-doc-target-select')
    await expect(select).toBeVisible()
    await shot(second.phone, 'sheet-pick')
    await select.selectOption(OTHER)
    await expect(select, 'the choice stays on screen').toHaveValue(OTHER)
    await waitArmed(second.phone)
    await tap(second.cdp, second.phone, second.phone.getByTestId('phone-doc-send'))
    await expect(second.phone.getByTestId('phone-doc-notice')).toContainText('T102 Other', { timeout: 15_000 })
    await waitForBufferText(page, OTHER, 'ANSWER', 15_000)
    // its chat is another session's: moving there must survive the panel's own Back
    await tap(second.cdp, second.phone, second.phone.getByTestId('phone-doc-notice-chat'))
    await expect(second.phone.getByTestId('phone-doc-panel')).toHaveCount(0, { timeout: 3_000 })
    await expect(second.phone.getByTestId('phone-session')).toHaveAttribute('data-session-id', OTHER, { timeout: 5_000 })
    await second.phone.waitForTimeout(800)
    await expect(second.phone.getByTestId('phone-session'), 'and stay there').toHaveAttribute('data-session-id', OTHER)
})

test('T102 links, missing pictures and fonts: the page stays where it is and says what is missing', async () => {
    test.setTimeout(180_000)
    const { app, base } = await launch()
    const { phone, cdp } = await openPhone(app, base, 't102-links')

    const frame = await openDoc(cdp, phone, 'the eli5 report')
    // a page in the web: the frame does not go there; the person gets a real link
    await tapInFrame(cdp, phone, frame.locator('#ext'))
    const link = phone.getByTestId('phone-doc-link')
    await expect(link).toHaveAttribute('href', 'https://example.invalid/x', { timeout: 5_000 })
    await expect(link).toHaveAttribute('target', '_blank')
    await expect(link).toHaveAttribute('rel', /noopener/)
    await shot(phone, 'link-sheet')
    await tap(cdp, phone, phone.getByTestId('phone-doc-cancel'))
    expect(new URL(docFrame(phone).url()).pathname).toMatch(/\/eli5\.html$/)
    // words written here must be there on the way back from a page next to it
    await tapInFrame(cdp, phone, frame.locator('.eli5-fb-btn').first())
    await frame.locator('#eli5-fb-ta-0').fill('kept-across-pages')
    await phone.waitForTimeout(150)
    // a page next to it: replaces this one, with the bridge in it, without a stop on the way back
    await tapInFrame(cdp, phone, frame.locator('#rel'))
    await expect(frame.locator('h1')).toHaveText('second doc', { timeout: 5_000 })
    // the ⬇ saves the document the chat named: not offered for a page it did not name
    await expect(phone.getByTestId('phone-doc-save')).toHaveCount(0)
    // it keeps its own words, apart from the first page's
    await docFrame(phone).evaluate(() => (window as unknown as { __setNote(value: string): void }).__setNote('second-page-note'))
    await phone.waitForTimeout(150)
    await tapInFrame(cdp, phone, frame.locator('#back'))
    await expect(frame.locator('.eli5-fb-btn').first()).toBeVisible({ timeout: 5_000 })
    await expect.poll(async () => {
        const button = frame.locator('.eli5-fb-btn').first()
        if ((await button.getAttribute('aria-expanded')) !== 'true') await tapInFrame(cdp, phone, button)
        return frame.locator('#eli5-fb-ta-0').inputValue()
    }, { timeout: 5_000 }).toBe('kept-across-pages')
    await tapInFrame(cdp, phone, frame.locator('#rel'))
    await expect.poll(() => docFrame(phone).evaluate(() => document.title), { timeout: 5_000 }).toBe('second-page-note')
    await tapInFrame(cdp, phone, frame.locator('#back'))
    await expect(phone.getByTestId('phone-doc-save')).toHaveCount(1, { timeout: 5_000 })
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0, { timeout: 3_000 })

    // a link to a file of the Mac replaces this panel: closing it is one Back, no empty stop left behind
    const again = await openDoc(cdp, phone, 'the eli5 report')
    const lengthOpen = await phone.evaluate(() => history.length)
    await tapInFrame(cdp, phone, again.locator('#fl'))
    await expect(phone.getByTestId('phone-doc-refused')).toBeVisible({ timeout: 5_000 })
    expect(await phone.evaluate(() => history.length), 'the panel changed; the history did not').toBe(lengthOpen)
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0, { timeout: 3_000 })

    // what could not be loaded: outside this folder, or on the web. Counted, not silent
    await openDoc(cdp, phone, 'the missing page')
    await expect(phone.getByTestId('phone-doc-missing')).toContainText('2 images', { timeout: 10_000 })
    await shot(phone, 'missing')
    // the same page saying it is ready again (its DOMContentLoaded): the count stays
    await docFrame(phone).evaluate(() => parent.postMessage({ type: 'doc-ready', title: 'Missing', path: 'missing.html', seeded: false, hash: '' }, '*'))
    await phone.waitForTimeout(200)
    await expect(phone.getByTestId('phone-doc-missing')).toContainText('2 images')
    expect(await docFrame(phone).evaluate(() => (document.getElementById('here') as HTMLImageElement).naturalWidth)).toBeGreaterThan(0)
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))
    await expect(phone.getByTestId('phone-doc-panel')).toHaveCount(0)

    // a font next to the page: a font request is CORS even from the same host
    await openDoc(cdp, phone, 'the font page')
    await expect.poll(() => docFrame(phone).evaluate(async () => (await document.fonts.load('16px T102')).length), { timeout: 10_000 }).toBeGreaterThan(0)
    // and so is a module, whatever its extension
    await expect.poll(() => docFrame(phone).evaluate(() => (window as unknown as { __t102Module?: number }).__t102Module ?? 0), { timeout: 5_000 }).toBe(1)
    await tap(cdp, phone, phone.getByTestId('phone-doc-close'))

    // the charset and <html lang> of a page survive the script put in front of them
    await openDoc(cdp, phone, 'the plain page')
    expect(await docFrame(phone).evaluate(() => document.documentElement.lang)).toBe('ko')
    expect(await docFrame(phone).evaluate(() => (window as unknown as { __climDocBridge?: boolean }).__climDocBridge)).toBe(true)
})

test('T102 in WebKit too (opt-in): cookies ride along there, and the frame still reaches nothing', async () => {
    const core = process.env.T102_WEBKIT_CORE
    test.skip(!core, 'T102_WEBKIT_CORE names a playwright-core with its WebKit installed')
    test.setTimeout(180_000)
    const { base, transcript, page } = await launch()
    const before = fs.readFileSync(transcript, 'utf8')
    const output = await new Promise<string>((resolve, reject) => {
        execFile(process.execPath, [path.join(__dirname, 'fixtures/t102-webkit.cjs'), core!, `${base}/?session=${AGENT}&view=chat`, OWNER], { timeout: 150_000 }, (error, stdout, stderr) => (error ? reject(new Error(`${error.message}\n${stderr}`)) : resolve(stdout)))
    })
    const { version, probe, armedAtOnce } = JSON.parse(output) as { version: string; probe: Record<string, unknown>; armedAtOnce: boolean }
    console.log('T102 WebKit', version, JSON.stringify(probe))
    expect(probe.origin).toBe('null')
    expect(probe.fetchGet).toBe('THROW TypeError')
    expect(probe.fetchPost).toBe('THROW TypeError')
    expect(probe.fetchPostNoCors).toBe('THROW TypeError')
    expect(probe.xhr).toBe('error')
    expect(probe.imgNextTo).toBe('loaded')
    expect(probe.canvasRead).toBe('THROW SecurityError')
    expect(armedAtOnce).toBe(false)
    // the probe's words never reached the session; the comment did, when Send was pressed
    const stored = fs.readFileSync(transcript, 'utf8')
    expect(stored.slice(before.length)).not.toContain('PROBE-')
    await expect.poll(() => fs.readFileSync(transcript, 'utf8').includes('webkit-comment-words'), { timeout: 15_000 }).toBe(true)
    expect((await eventsOf(page, AGENT)).filter((e) => e.kind === 'phone-input').length, 'one send: the comment').toBe(1)
})
