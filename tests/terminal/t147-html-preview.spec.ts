import { test, expect, type ElectronApplication, type Frame, type Page } from '@playwright/test'
import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText } from './helpers'

/**
 * T147 — an HTML report the Chat names is drawn in the app (backlog 「앱 안 브라우저」, decision 0013).
 *
 *  A: a click on `report.html` opens the preview window drawing the page (925 KB, its script and its picture run in a
 *     sandboxed frame), not the browser — `shell.openPath` 0 times; Preview/Source; `:line` opens on the source; Escape
 *     (from the window or from inside the page) closes it and gives the focus back to the Chat; Browser still opens the
 *     Mac's browser (no Artifact Dock here → `shell.openPath`).
 *  probe: what the frame's code tries is judged where it would land — main's `webRequest` and a real HTTP server. A
 *     control request from a window of the app proves both see requests at all.
 *  B: Side by side → the split view holds the session and the page; the session takes input at once; a pane's
 *     Preview/Source/Browser/close; four panes turn Side by side off with the reason.
 *
 * T147_SHOTS=<dir> + T147_LABEL save captures before the checks, so the old code's «before» comes from the same run.
 */

const MOCK = path.join(REPO_ROOT, 'scripts/mock-cli/chat-mock.cjs')
const CLAUDE = 't147-claude'
const CLAUDE_ID = '00000000-0000-4000-8000-0000000c1470'
const LABEL = process.env.T147_LABEL ?? 'after'
const REPORT_BYTES = 925 * 1024
/** a 1×1 red PNG */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64')

let result: LaunchResult | null = null
let probeServer: http.Server | null = null
test.afterEach(async () => {
    if (result) await closeApp(result)
    result = null
    if (probeServer) await new Promise<void>((resolve) => probeServer!.close(() => resolve()))
    probeServer = null
})

const chat = (page: Page) => page.locator('[data-testid="chat-view"][data-session-id]:visible')
const preview = (page: Page) => page.getByTestId('chat-file-preview')

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T147_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}-1280.png`) })
}

/** A report of `REPORT_BYTES`: a table, a picture beside it, and a script that needs storage. */
function bigReport(): string {
    const head = '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Weekly release review</title>' +
        '<style>body{font:13px -apple-system,sans-serif;margin:24px;color:#1f2329}td{border-bottom:1px solid #eee;padding:4px 8px}</style></head>' +
        '<body><h1 id="title">Weekly release review</h1><img id="pic" src="pic.png" width="40" height="40"><table>'
    const tail = '</table><script>localStorage.setItem("k", "v"); document.body.dataset.ran = localStorage.getItem("k") + ":" + document.querySelectorAll("tr").length</script></body></html>\n'
    const rows: string[] = []
    let size = head.length + tail.length
    for (let i = 0; size < REPORT_BYTES; i++) {
        const row = `<tr><td>${i}</td><td>Reply in thread, side panel</td><td>shipped</td><td>${'x'.repeat(20)}</td></tr>\n`
        rows.push(row)
        size += row.length
    }
    return head + rows.join('') + tail
}

/** What the frame's own code tries. Every address carries `probe=`; the results come back by postMessage. */
const PROBE_PAGE = (port: number): string => `<!doctype html><html><head><meta charset="utf-8"><title>Probe</title>
<script src="http://127.0.0.1:${port}/probe=script"></script>
<link rel="stylesheet" href="http://127.0.0.1:${port}/probe=css">
</head><body><h1>probe</h1><img id="rel" src="pic.png"><img id="out" src="http://127.0.0.1:${port}/probe=img.png">
<script>
(async function () {
    var R = {}
    window.__R = R
    var out = 'http://127.0.0.1:${port}/'
    var t = async function (name, run) { R.step = name; try { R[name] = await run() } catch (e) { R[name] = 'THROW ' + (e && e.name) } }
    await t('origin', function () { return self.origin })
    await t('parentApi', function () { return typeof parent.api })
    await t('parentDom', function () { return parent.document.title })
    await t('topLocation', function () { return top.location.href })
    await t('storage', function () { localStorage.setItem('k', 'v'); return localStorage.getItem('k') })
    await t('fetch', function () { return fetch(out + 'probe=fetch').then(function (r) { return 'status ' + r.status }) })
    await t('fetchNoCors', function () { return fetch(out + 'probe=nocors', { mode: 'no-cors' }).then(function (r) { return 'type=' + r.type }) })
    await t('fetchPost', function () { return fetch(out + 'probe=post', { method: 'POST', mode: 'no-cors', body: 'x' }).then(function (r) { return 'type=' + r.type }) })
    await t('beacon', function () { return String(navigator.sendBeacon(out + 'probe=beacon', 'x')) })
    await t('xhr', function () { return new Promise(function (ok) { var x = new XMLHttpRequest(); x.open('GET', out + 'probe=xhr'); x.onload = function () { ok('READ') }; x.onerror = function () { ok('error') }; x.send() }) })
    await t('socket', function () { return new Promise(function (ok) { var w = new WebSocket('ws://127.0.0.1:${port}/probe=ws'); w.onopen = function () { ok('OPEN') }; w.onerror = function () { ok('error') }; setTimeout(function () { ok('timeout') }, 1500) }) })
    await t('popup', function () { return String(!!window.open(out + 'probe=popup')) })
    await new Promise(function (r) { setTimeout(r, 600) })
    var img = function (id) { var e = document.getElementById(id); return e.complete && e.naturalWidth > 0 ? 'loaded' : 'failed' }
    R.imgNextTo = img('rel')
    R.imgOutside = img('out')
    parent.postMessage({ type: 'probe', R: R }, '*')
    // last, since either may replace the page: a form posted to the web, then the frame leaving for it
    setTimeout(function () { var f = document.createElement('form'); f.action = out + 'probe=form'; f.method = 'POST'; var i = document.createElement('input'); i.name = 'x'; i.value = '1'; f.appendChild(i); document.body.appendChild(f); f.submit() }, 200)
    setTimeout(function () { location.href = out + 'probe=navigate' }, 600)
})()
</script></body></html>`

interface Launched {
    app: ElectronApplication
    page: Page
    project: string
    report: string
    opened: () => Promise<string[]>
    requests: () => Promise<string[]>
    hits: string[]
    port: number
}

async function launch(): Promise<Launched> {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 't147-')))
    const hits: string[] = []
    probeServer = http.createServer((req, res) => {
        hits.push(req.url ?? '')
        res.end('ok')
    })
    await new Promise<void>((resolve) => probeServer!.listen(0, '127.0.0.1', resolve))
    const port = (probeServer.address() as AddressInfo).port

    const project = path.join(dir, 'project')
    fs.mkdirSync(project, { recursive: true })
    const report = path.join(project, 'report.html')
    fs.writeFileSync(report, bigReport())
    fs.writeFileSync(path.join(project, 'pic.png'), PIXEL)
    fs.writeFileSync(path.join(project, 'probe.html'), PROBE_PAGE(port))
    fs.writeFileSync(path.join(project, 'small.html'), '<!doctype html>\n<html>\n<head><title>T147 small</title></head>\n<body><h1>Small</h1></body>\n</html>\n')

    const claudeDir = path.join(dir, 'claude')
    const transcript = path.join(claudeDir, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'), `${CLAUDE_ID}.jsonl`)
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    const ts = (n: number): string => new Date(Date.UTC(2026, 10, 16, 1, 0, n)).toISOString()
    fs.writeFileSync(transcript, [
        { type: 'user', uuid: '00000000-0000-4000-8000-000000000001', timestamp: ts(1), message: { role: 'user', content: '보고서 어디 있어?' } },
        { type: 'assistant', uuid: '00000000-0000-4000-8000-000000000002', timestamp: ts(2), message: { role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: 'The review is `report.html`, the probe is `probe.html`, and the title sits at `small.html:3`.' }] } }
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t147', name: 'T147 project', path: project, sessions: [{ id: CLAUDE, name: 'T147 Claude', cliSessionId: CLAUDE_ID, cliToolName: 'claude', cliCommand: `node ${MOCK} --transcript ${transcript} --continue --mode-row none` }] }],
        // no Artifact Dock: the Browser button goes to the Mac's opener
        { env: { CLAUDE_CONFIG_DIR: claudeDir, ARTIFACT_DOCK_SOCKET: path.join(dir, 'no-dock.sock') } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    await app.evaluate(({ shell, session }) => {
        const g = globalThis as unknown as { __opened: string[]; __requests: string[] }
        g.__opened = []
        g.__requests = []
        shell.openPath = async (target: string) => {
            g.__opened.push(target)
            return ''
        }
        session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
            g.__requests.push(details.url)
            callback({})
        })
    })
    await waitForBufferText(page, CLAUDE, 'Claude Code (mock)', 20_000)
    await page.getByText('T147 Claude', { exact: true }).first().click()
    await page.getByTestId('view-toggle-chat').click()
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
    await expect(chat(page).getByRole('button', { name: 'report.html', exact: true }).first()).toBeVisible({ timeout: 15_000 })
    return {
        app,
        page,
        project,
        report,
        hits,
        port,
        opened: () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened),
        requests: () => app.evaluate(() => (globalThis as unknown as { __requests: string[] }).__requests)
    }
}

async function frameOf(page: Page, scope = page.locator('body')): Promise<Frame> {
    const handle = await scope.getByTestId('html-doc-frame').elementHandle({ timeout: 15_000 })
    const frame = await handle?.contentFrame()
    if (!frame) throw new Error('no document frame')
    return frame
}

const focusInChat = (page: Page): Promise<boolean> => page.evaluate(() => Boolean(document.activeElement?.closest('[data-testid="chat-view"]')))

test('T147 A: a report opens drawn in the preview window — Source, :line, Escape back to the Chat, Browser', async () => {
    test.setTimeout(180_000)
    const { app, page, report, opened } = await launch()

    await chat(page).getByRole('button', { name: 'report.html', exact: true }).first().click()
    await shot(page, 't147-a-preview')
    await expect(preview(page)).toHaveAttribute('data-path', report)
    const frameElement = preview(page).getByTestId('html-doc-frame')
    await expect(frameElement).toBeVisible({ timeout: 15_000 })
    expect(await frameElement.getAttribute('sandbox')).toBe('allow-scripts allow-forms allow-modals')
    expect(fs.statSync(report).size).toBeGreaterThanOrEqual(REPORT_BYTES)
    // drawn: the page's words, its script ran (with storage), its picture beside it loaded
    const frame = await frameOf(page, preview(page))
    await expect(frame.locator('#title')).toHaveText('Weekly release review')
    await expect.poll(() => frame.evaluate(() => document.body.dataset.ran ?? '')).toMatch(/^v:\d{4,}$/)
    expect(await frame.evaluate(() => (document.getElementById('pic') as HTMLImageElement).naturalWidth)).toBe(1)
    expect(await frame.evaluate(() => self.origin)).toBe('null')
    await expect(page.getByTestId('file-preview-sandboxed')).toHaveText('Sandboxed · no network')
    await expect(page.getByTestId('file-preview-rendered')).toHaveAttribute('aria-pressed', 'true')
    expect(await opened(), 'the browser was not asked').toEqual([])
    // the frame fills the big window
    const box = await frameElement.boundingBox()
    expect(box!.width).toBeGreaterThan(900)
    expect(box!.height).toBeGreaterThan(500)

    // Escape from inside the page closes it (the bridge), focus back in the Chat
    await frame.locator('#title').click()
    await page.keyboard.press('Escape')
    await expect(preview(page)).toHaveCount(0)
    await expect.poll(() => focusInChat(page)).toBe(true)

    // Source and back; Escape from the window
    await chat(page).getByRole('button', { name: 'probe.html', exact: true }).first().click()
    await expect(preview(page).getByTestId('html-doc-frame')).toBeVisible()
    await page.getByTestId('file-preview-source').click()
    await expect(preview(page).getByTestId('html-doc-source')).toContainText('<title>Probe</title>')
    await expect(preview(page).getByTestId('html-doc-frame')).toHaveCount(0)
    await expect(page.getByTestId('file-preview-sandboxed')).toHaveCount(0)
    await page.getByTestId('file-preview-rendered').click()
    await expect(preview(page).getByTestId('html-doc-frame')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(preview(page)).toHaveCount(0)
    await expect.poll(() => focusInChat(page)).toBe(true)

    // a line is a place in the source
    await chat(page).getByRole('button', { name: /small\.html:3/ }).first().click()
    await expect(preview(page).getByTestId('html-doc-source')).toBeVisible()
    await expect(page.getByTestId('file-preview-source')).toHaveAttribute('aria-pressed', 'true')
    await expect(preview(page).locator('.line-3')).toHaveClass(/bg-yellow-500/)
    await expect(preview(page).locator('.line-3')).toContainText('T147 small')
    await shot(page, 't147-a-line')
    await page.locator('[data-testid="chat-file-preview"] button[title^="Close"]').click()
    await expect(preview(page)).toHaveCount(0)
    await expect.poll(() => focusInChat(page)).toBe(true)

    // Browser: the Mac's opener, as before
    await chat(page).getByRole('button', { name: 'report.html', exact: true }).first().click()
    await page.getByTestId('file-preview-browser').click()
    await expect.poll(opened).toEqual([report])
    // the token's address opened at the top of a window is still an opaque origin with no app API (the header's sandbox)
    const src = (await preview(page).getByTestId('html-doc-frame').getAttribute('src'))!
    expect(src).toMatch(/^climanager-doc:\/\/doc\/[A-Za-z0-9_-]+\/report\.html$/)
    const top = await app.evaluate(async ({ BrowserWindow }, url) => {
        const win = new BrowserWindow({ show: false })
        await win.loadURL(url)
        const seen = await win.webContents.executeJavaScript('JSON.stringify({ origin: self.origin, api: typeof window.api, title: document.title })')
        win.destroy()
        return JSON.parse(seen) as { origin: string; api: string; title: string }
    }, src)
    expect(top).toEqual({ origin: 'null', api: 'undefined', title: 'Weekly release review' })
})

test('T147 probe: nothing the frame\'s code tries reaches the network or the app', async () => {
    test.setTimeout(150_000)
    const { app, page, hits, port, requests } = await launch()
    // the control: a window of the app asks the probe server, and both main's hook and the server see it
    await app.evaluate(async ({ BrowserWindow }, url) => {
        const win = new BrowserWindow({ show: false })
        await win.loadURL(url).catch(() => undefined)
        win.destroy()
    }, `http://127.0.0.1:${port}/probe=control`)
    expect((await requests()).some((url) => url.includes('probe=control')), 'main\'s hook sees requests').toBe(true)
    expect(hits.some((url) => url.includes('probe=control')), 'the server sees requests').toBe(true)

    await page.evaluate(() => window.addEventListener('message', (event) => {
        if ((event.data as { type?: string })?.type === 'probe') (window as unknown as { __probe: unknown }).__probe = (event.data as { R: unknown }).R
    }))
    await chat(page).getByRole('button', { name: 'probe.html', exact: true }).first().click()
    await expect(preview(page).getByTestId('html-doc-frame')).toBeVisible({ timeout: 15_000 })
    const frame = await frameOf(page, preview(page))
    const reached = await expect.poll(() => page.evaluate(() => (window as unknown as { __probe: unknown }).__probe ?? null), { timeout: 20_000 }).not.toBeNull().then(() => null, (error: unknown) => error)
    if (reached) {
        console.log('T147 probe stopped at', await frame.evaluate(() => JSON.stringify({ R: (window as unknown as { __R?: unknown }).__R ?? null, href: location.href, title: document.title, body: document.documentElement.outerHTML.slice(0, 300) })).catch((error: unknown) => String(error)))
        throw reached
    }
    const probe = (await page.evaluate(() => (window as unknown as { __probe: unknown }).__probe)) as Record<string, unknown>
    console.log('T147 probe', JSON.stringify(probe))
    expect(probe.origin).toBe('null')
    expect(probe.parentApi).toBe('THROW SecurityError')
    expect(probe.parentDom).toBe('THROW SecurityError')
    expect(probe.topLocation).toBe('THROW SecurityError')
    expect(probe.storage, 'the bridge keeps a page\'s storage working').toBe('v')
    expect(probe.fetch).toBe('THROW TypeError')
    expect(probe.fetchNoCors).toBe('THROW TypeError')
    expect(probe.fetchPost).toBe('THROW TypeError')
    expect(probe.xhr).toBe('error')
    expect(probe.socket).toBe('error')
    expect(probe.popup).toBe('false')
    expect(probe.imgNextTo).toBe('loaded')
    expect(probe.imgOutside).toBe('failed')
    // the navigation attempt runs last; give it and the beacon/form time to land if they could
    await page.waitForTimeout(2_000)
    const left = (await requests()).filter((url) => url.includes('probe=') && !url.includes('probe=control'))
    expect(left, 'nothing the frame tried left the browser').toEqual([])
    expect(hits.filter((url) => !url.includes('probe=control')), 'nothing reached the server').toEqual([])
    // the app is still here, the preview too (the wrapper has no box of its own: look at the frame)
    await expect(preview(page).getByTestId('html-doc-frame')).toBeVisible()
    expect(probe.beacon, 'sendBeacon only queues; the request never left (checked above)').toBe('true')
})

test('T147 B: Side by side puts the page in split view beside the session, which takes input at once; four panes is the limit', async () => {
    test.setTimeout(180_000)
    const { page, report, opened } = await launch()
    const docPanes = page.locator('[data-doc-pane]')

    await chat(page).getByRole('button', { name: 'report.html', exact: true }).first().click()
    await expect(preview(page).getByTestId('html-doc-frame')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('file-preview-side-by-side').click()
    await expect(preview(page)).toHaveCount(0)
    await expect(page.locator('[data-split-grid] > *').filter({ has: page.locator('[data-pane-header]') })).toHaveCount(2)
    await expect(page.locator(`[data-pane-header="${CLAUDE}"]`)).toBeVisible()
    await expect(docPanes).toHaveCount(1)
    await expect(docPanes.first()).toHaveAttribute('data-path', report)
    const frame = await frameOf(page, docPanes.first())
    await expect(frame.locator('#title')).toHaveText('Weekly release review')
    // the pane sits right of the session, side by side
    const sessionBox = await page.locator(`[data-pane-header="${CLAUDE}"]`).boundingBox()
    const docBox = await docPanes.first().boundingBox()
    expect(docBox!.x).toBeGreaterThan(sessionBox!.x + sessionBox!.width - 2)
    expect(docBox!.height).toBeGreaterThan(400)
    await shot(page, 't147-b-split')
    // the focus went back to the Chat, and the session takes input at once
    await expect.poll(() => focusInChat(page)).toBe(true)
    const composer = chat(page).getByTestId('chat-composer')
    await composer.fill('beside the report')
    await composer.press('Enter')
    await waitForBufferText(page, CLAUDE, 'ANSWER[1]: beside the report', 15_000)

    // the pane's own Source / Preview / Browser
    await docPanes.first().getByTestId('doc-pane-source').click()
    await expect(docPanes.first().getByTestId('html-doc-frame')).toHaveCount(0)
    // the source view reads words, so the text preview's 500 KB limit says so for this 925 KB page
    await expect(docPanes.first()).toContainText('File too large')
    await docPanes.first().getByTestId('doc-pane-preview').click()
    await expect(docPanes.first().getByTestId('html-doc-frame')).toBeVisible()
    await docPanes.first().getByTestId('doc-pane-browser').click()
    await expect.poll(opened).toEqual([report])

    // two more pages: four panes, and a fifth is refused with the reason
    for (const name of ['probe.html', 'report.html']) {
        await chat(page).getByRole('button', { name, exact: true }).first().click()
        await page.getByTestId('file-preview-side-by-side').click()
        await expect(preview(page)).toHaveCount(0)
    }
    await expect(docPanes).toHaveCount(3)
    await chat(page).getByRole('button', { name: 'report.html', exact: true }).first().click()
    const side = page.getByTestId('file-preview-side-by-side')
    await expect(side).toBeDisabled()
    expect(await side.getAttribute('title')).toContain('4 panes')
    await shot(page, 't147-b-four')
    // FilePreview listens for keys 100 ms after it opens, so the key that opened it does not close it
    await page.waitForTimeout(200)
    await page.keyboard.press('Escape')
    await expect(preview(page)).toHaveCount(0)

    // closing the pages: back to the single view of the session
    for (let left = 3; left > 0; left--) {
        await docPanes.first().getByTestId('doc-pane-close').click()
        await expect(docPanes).toHaveCount(left - 1)
    }
    await expect(page.locator('[data-split-grid]')).toHaveCount(0)
    await expect(chat(page).getByTestId('chat-composer')).toBeVisible()
})
