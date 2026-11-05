import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, LaunchResult, REPO_ROOT, resizeMainWindow, waitForBufferText, writeToTerminal } from './helpers'

/**
 * T85 — the feedback widget on the phone page, against the real app and its phone server
 * (touch phone: CDP 390×844, scale 3, owner let in as `tailscale serve` does it).
 *
 *  - a Mac without feedback mode: the phone shows no Feedback button and never loads the widget chunk
 *  - feedback mode on at the Mac: the button is in the session list header; the kit's own floating
 *    button is hidden, so the terminal key bar and Send are what a thumb reaches there
 *  - a report from a session: through the phone server to main's relay (main's fetch is replaced —
 *    nothing reaches Lasso Run), carrying url …/phone?screen=session, extra.surface 'phone', the
 *    viewed session's masked lines and a screenshot — and no owner login, cookie or ingest key in extra
 *  - feedback mode off again: the button goes (after /me), and the relay answers 403
 */

const SHELL = 't85-shell'
const OWNER = 'owner-t85@example.com'
const DPR = 3
const T85_PORT = 47885
const GATE_SOURCE = path.join(REPO_ROOT, 'src/renderer/src/utils/feedbackGate.ts')
const RENDERER_ASSETS = path.join(REPO_ROOT, 'out/renderer/assets')
const FEEDBACK_BUNDLE_MARKER = 'dp-agentation-ingest/'
const KIT_BUTTON = '#feedback-kit-floating-button'

function buildHasFeedback(): boolean {
    if (!fs.existsSync(RENDERER_ASSETS)) return false
    return fs.readdirSync(RENDERER_ASSETS)
        .filter((name) => name.endsWith('.js'))
        .some((name) => fs.readFileSync(path.join(RENDERER_ASSETS, name), 'utf-8').includes(FEEDBACK_BUNDLE_MARKER))
}

function gateConstants(): { hash: string; storageKey: string } {
    const source = fs.readFileSync(GATE_SOURCE, 'utf-8')
    const hash = /FEEDBACK_PASSWORD_HASH = '([0-9a-f]{64})'/.exec(source)?.[1]
    const storageKey = /UNLOCK_STORAGE_KEY = '([^']+)'/.exec(source)?.[1]
    if (!hash || !storageKey) throw new Error('feedbackGate.ts constants not found')
    return { hash, storageKey }
}

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

async function launch(): Promise<{ app: ElectronApplication; page: Page; base: string }> {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t85-'))
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t85', name: 'T85 project', path: home, sessions: [{ id: SHELL, name: 'T85 Shell' }] }],
        { settings: { phone: { enabled: true, port: T85_PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile } }
    )
    const { app, page } = result
    await resizeMainWindow(app, 1280, 800)
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    return { app, page, base: `http://127.0.0.1:${state.port}` }
}

/** A phone window in its own cookie jar, let in as this Mac's owner the way `tailscale serve` does it. */
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
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: DPR, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
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

/** Feedback mode on at the Mac: the remembered unlock (T31), then a reload so FeedbackGate reports it. */
async function unlockAtMac(page: Page): Promise<void> {
    const { hash, storageKey } = gateConstants()
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageKey, hash])
    await page.reload()
    await expect(page.locator(KIT_BUTTON)).toBeVisible({ timeout: 20_000 })
}

/** Main's fetch answers for the ingest: the payload is captured, nothing leaves the machine. */
async function captureIngest(app: ElectronApplication): Promise<void> {
    await app.evaluate(() => {
        const g = globalThis as unknown as { fetch: typeof fetch; __t85Bodies: string[] }
        const original = g.fetch
        g.__t85Bodies = []
        g.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            if (!String(input).includes('/functions/v1/dp-agentation-ingest/')) return original(input, init)
            if (init?.method !== 'POST') return new Response('{}', { status: 404 })
            g.__t85Bodies.push(String(init.body ?? ''))
            return new Response(JSON.stringify({ ok: true, annotationId: 't85' }), { status: 201, headers: { 'content-type': 'application/json' } })
        }) as typeof fetch
    })
}

const ingestBodies = (app: ElectronApplication): Promise<string[]> =>
    app.evaluate(() => (globalThis as unknown as { __t85Bodies?: string[] }).__t85Bodies ?? [])

/** Script and style files the phone page has loaded so far. */
const loadedAssets = (phone: Page): Promise<string[]> =>
    phone.evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name).filter((name) => name.includes('/assets/')))

test('T85 a Mac without feedback mode: no button on the phone, no widget chunk', async () => {
    test.setTimeout(120_000)
    test.skip(!buildHasFeedback(), 'build has no VITE_DP_FEEDBACK_URL/KEY')
    const { app, base } = await launch()
    const { phone } = await openPhone(app, `${base}/`, 't85-locked')
    await expect(phone.getByTestId('phone-sidebar')).toBeVisible({ timeout: 15_000 })
    await phone.waitForLoadState('networkidle')
    const me = await phone.evaluate(() => fetch('/api/phone/me').then((r) => r.json()))
    expect(me.access).toBe('full')
    expect(me.feedback).toBeUndefined()
    await expect(phone.getByTestId('phone-feedback-button')).toHaveCount(0)
    await expect(phone.locator(KIT_BUTTON)).toHaveCount(0)
    const assets = await loadedAssets(phone)
    expect(assets.some((name) => name.includes('PhoneFeedbackWidget')), assets.join('\n')).toBe(false)
})

test('T85 feedback mode on: the button opens the report; it reaches main relay with the phone context', async () => {
    test.setTimeout(180_000)
    test.skip(!buildHasFeedback(), 'build has no VITE_DP_FEEDBACK_URL/KEY')
    const { app, page, base } = await launch()
    await waitForBufferText(page, SHELL, '$', 20_000).catch(() => undefined)
    // what the report's terminal lines must show, computed by the shell so the typed line alone does not count
    await writeToTerminal(page, SHELL, 'echo T85-MARK-$((40+2))\r')
    await waitForBufferText(page, SHELL, 'T85-MARK-42', 15_000)
    await captureIngest(app)
    await unlockAtMac(page)

    const { phone, cdp } = await openPhone(app, `${base}/?session=${SHELL}&view=terminal`, 't85-on')
    await expect(phone.getByTestId('phone-session')).toBeVisible({ timeout: 15_000 })
    const me = await phone.evaluate(() => fetch('/api/phone/me').then((r) => r.json()))
    expect(me.feedback?.appVersion).toBeTruthy()

    // the kit mounts (lazy chunk) but its floating button takes no room at the bottom-right
    await expect(phone.locator(KIT_BUTTON)).toHaveCount(1, { timeout: 15_000 })
    await expect(phone.locator(KIT_BUTTON)).toBeHidden()
    const bottomRight = await phone.evaluate(() => {
        const el = document.elementFromPoint(window.innerWidth - 40, window.innerHeight - 40)
        return el ? (el.closest('[data-feedback-kit]') ? 'kit' : 'page') : 'none'
    })
    expect(bottomRight).not.toBe('kit')

    // ☰ → Feedback: the drawer closes and the report opens with the session screen captured
    await tap(cdp, phone, 'phone-menu-button')
    await expect(phone.getByTestId('phone-feedback-button')).toBeVisible()
    await tap(cdp, phone, 'phone-feedback-button')
    const comment = phone.locator('#feedback-kit-comment')
    await expect(comment).toBeVisible({ timeout: 15_000 })
    await expect(phone.getByTestId('phone-sidebar')).toHaveCount(0)
    await comment.fill('[t85] phone report check')
    await phone.locator('[aria-labelledby="feedback-kit-dialog-title"] button[type="submit"]').click()
    await expect(phone.getByText('보냈습니다').first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(async () => (await ingestBodies(app)).length, { timeout: 30_000 }).toBe(1)

    const [body] = await ingestBodies(app)
    // the Lasso Run envelope (feedback-kit buildLassoEnvelope): url on top, the report's parts under `report`
    const payload = JSON.parse(body) as { url: string; report: { comment: string; screenshotBase64: string | null; web: { url: string } | null; context: { extra: Record<string, any> } } }
    const report = payload.report
    expect(report.comment).toBe('[t85] phone report check')
    expect(payload.url).toBe('https://desktop.climanager.solhun.com/phone?screen=session')
    expect(report.web?.url).toBe(payload.url)
    expect(report.context.extra).toMatchObject({ surface: 'phone', phoneVia: 'tailscale', phoneSessionId: SHELL, phoneView: 'terminal', phoneDevice: null })
    expect(report.context.extra.appVersion).toBe(me.feedback.appVersion)
    expect(report.context.extra.terminal).toMatchObject({ sessionId: SHELL, source: 'viewing' })
    expect((report.context.extra.terminal.recentLines as string[]).join('\n')).toContain('T85-MARK-42')
    expect(report.screenshotBase64?.length ?? 0, 'the screen was captured').toBeGreaterThan(10_000)
    // the relay cap (PHONE_FEEDBACK_MAX_BYTES) is set against this: a full-scale 390×844 ×3 screen
    console.log(`T85 report body ${body.length} bytes, screenshot ${report.screenshotBase64?.length} base64 bytes`)
    if (process.env.PHONE_SHOTS && report.screenshotBase64) {
        fs.mkdirSync(process.env.PHONE_SHOTS, { recursive: true })
        fs.writeFileSync(path.join(process.env.PHONE_SHOTS, 't85-report-screenshot.png'), Buffer.from(report.screenshotBase64, 'base64'))
    }
    // the owner's login, the phone cookie and the ingest key stay out of what the report says about itself
    const extraText = JSON.stringify(report.context.extra)
    expect(extraText).not.toContain(OWNER)
    expect(body).not.toContain('climanager_phone')
    expect(extraText).not.toContain('dp_ingest_')

    // off at the Mac: /me says nothing, the relay refuses, and the reloaded page shows no button
    await page.evaluate(() => document.dispatchEvent(new CustomEvent('feedback:toggle')))
    await expect.poll(() => phone.evaluate(() => fetch('/api/phone/me').then((r) => r.json()).then((m) => 'feedback' in m)), { timeout: 10_000 }).toBe(false)
    const refused = await phone.evaluate(() => fetch('/api/phone/feedback/relay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://x.supabase.co/functions/v1/dp-agentation-ingest/s', method: 'POST', headers: {}, body: '{}' })
    }).then((r) => r.status))
    expect(refused).toBe(403)
    await phone.reload()
    await expect(phone.getByTestId('phone-session')).toBeVisible({ timeout: 15_000 })
    await tap(cdp, phone, 'phone-menu-button')
    await expect(phone.getByTestId('phone-sidebar')).toBeVisible()
    await expect(phone.getByTestId('phone-feedback-button')).toHaveCount(0)
})

test('T85 the terminal key bar and Send stay reachable with the widget mounted', async () => {
    test.setTimeout(120_000)
    test.skip(!buildHasFeedback(), 'build has no VITE_DP_FEEDBACK_URL/KEY')
    const { app, page, base } = await launch()
    await unlockAtMac(page)
    const { phone, cdp } = await openPhone(app, `${base}/?session=${SHELL}&view=terminal`, 't85-layout')
    await expect(phone.getByTestId('phone-terminal')).toHaveAttribute('data-status', 'live', { timeout: 15_000 })
    await expect(phone.locator(KIT_BUTTON)).toHaveCount(1, { timeout: 15_000 })
    await tap(cdp, phone, 'phone-terminal-type')
    await expect(phone.getByTestId('phone-key-bar')).toBeVisible()
    // every key-bar button and the terminal Send take the touch themselves — nothing of the kit on top
    const covered = await phone.evaluate(() => {
        const targets = [...Array.from(document.querySelectorAll('[data-testid="phone-key-bar"] button')), document.querySelector('[data-testid="phone-terminal-send"]')]
        return targets.filter((el): el is Element => el !== null).filter((el) => {
            const box = el.getBoundingClientRect()
            // a key scrolled out of the bar is not on screen to cover
            if (box.right <= 0 || box.left >= window.innerWidth || box.width === 0) return false
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
            return !hit || !(el === hit || el.contains(hit))
        }).map((el) => el.textContent)
    })
    expect(covered).toEqual([])
})
