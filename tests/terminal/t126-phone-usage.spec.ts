import { test, expect, type CDPSession, type ElectronApplication, type Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { closeApp, launchAppWithWorkspaces, type LaunchResult } from './helpers'
import { AgentSwapReader, appUsageForPhone, parseAgentSwapList, runAgentSwapInLoginShell, shortenEmail } from '../../src/main/phone/phoneUsage'
import { untilReset } from '../../src/renderer/src/phone/usageText'

/**
 * T126 — the phone's usage view (3b4efdfc): the app's own reading and agent-swap's accounts.
 *
 *  Units (no Electron): `aswap list --json` parsing (alias, shortened email, last good reading,
 *  error payload, other schema, Codex epoch seconds), the reader's minute cache, one run at a time,
 *  a failure kept as long as an answer, the login-shell runner's time limit and a missing command.
 *  App: a fake agent-swap (a script standing in for the shell — never the user's own accounts):
 *  ☰ → Usage → the accounts with their bars, drawn over the chat, inside 390, read once a minute.
 *
 *  All accounts here are made up. T126_SHOTS=<dir> + T126_LABEL saves 390 captures before the checks.
 */

const NOW = Date.UTC(2026, 10, 12, 6, 0, 0)
const iso = (msFromNow: number): string => new Date(NOW + msFromNow).toISOString()
const HOUR = 3_600_000

/** the shape `aswap list --json` prints (agent-swap README «JSON output»), with made-up accounts */
function swapList(): Record<string, unknown> {
    return {
        schemaVersion: 1,
        activeAccountNumber: 1,
        accounts: [
            {
                number: 1,
                email: 'first.person@example.com',
                active: true,
                usageStatus: 'ok',
                usage: {
                    fiveHour: { pct: 42.0, resetsAt: iso(2 * HOUR) },
                    sevenDay: { pct: 91.0, resetsAt: iso(50 * HOUR), projectedExhaustionAt: iso(10 * HOUR), willLastToReset: false, unknownField: 1 }
                },
                usageAgeSeconds: 33.4
            },
            { number: 2, email: 'second@example.org', alias: 'work', active: false, usageStatus: 'unavailable', usage: null, lastGoodUsage: { sevenDay: { pct: 12, resetsAt: iso(100 * HOUR) } }, lastGoodAgeSeconds: 900 },
            { number: 3, alias: 'no email — left out' }
        ],
        otherAgents: {
            codex: { status: 'ok', primary: { usedPercent: 7, resetsAt: Math.floor((NOW + HOUR) / 1000) }, secondary: { usedPercent: 63, resetsAt: Math.floor((NOW + 90 * HOUR) / 1000) } },
            muse: { status: 'not_installed' }
        }
    }
}

test.describe('T126 units', () => {
    test('email shortening keeps two letters of the name', () => {
        expect(shortenEmail('first.person@example.com')).toBe('fi…@example.com')
        expect(shortenEmail('ab@example.com')).toBe('ab@example.com')
        expect(shortenEmail('not-an-email')).toBe('no…')
    })

    test('aswap list --json reads into the phone shape', () => {
        const usage = parseAgentSwapList(JSON.stringify(swapList()), NOW)!
        expect(usage.readAt).toBe(NOW)
        expect(usage.accounts).toHaveLength(2)
        const [first, second] = usage.accounts
        expect(first).toEqual({
            label: 'fi…@example.com',
            active: true,
            status: 'ok',
            fiveHour: { usedPercent: 42, resetsAt: iso(2 * HOUR) },
            sevenDay: { usedPercent: 91, resetsAt: iso(50 * HOUR), projectedExhaustionAt: iso(10 * HOUR), willLastToReset: false },
            ageSeconds: 33
        })
        // the alias wins; usage gone stale falls back to the last good reading, as the human view does
        expect(second).toEqual({ label: 'work', active: false, status: 'unavailable', sevenDay: { usedPercent: 12, resetsAt: iso(100 * HOUR) }, ageSeconds: 900 })
        expect(JSON.stringify(usage)).not.toContain('first.person')
        expect(JSON.stringify(usage)).not.toContain('second@')
        // Codex's windows carry epoch seconds
        expect(usage.codex).toEqual({ primary: { usedPercent: 7, resetsAt: iso(HOUR) }, secondary: { usedPercent: 63, resetsAt: iso(90 * HOUR) } })
    })

    test('an error payload, another schema or not JSON is nothing', () => {
        expect(parseAgentSwapList('{"schemaVersion":1,"error":{"kind":"x"}}', NOW)).toBeNull()
        expect(parseAgentSwapList(JSON.stringify({ ...swapList(), schemaVersion: 2 }), NOW)).toBeNull()
        expect(parseAgentSwapList('aswap: command not found', NOW)).toBeNull()
        const codexOff = { ...swapList(), otherAgents: { codex: { status: 'not_logged_in' } } }
        expect(parseAgentSwapList(JSON.stringify(codexOff), NOW)!.codex).toBeUndefined()
    })

    test('the reader keeps an answer a minute and runs one at a time', async () => {
        let clock = NOW
        let runs = 0
        let release: (stdout: string) => void = () => undefined
        const reader = new AgentSwapReader(
            () =>
                new Promise<string>((resolve) => {
                    runs += 1
                    release = resolve
                }),
            () => clock
        )
        const a = reader.read()
        const b = reader.read()
        expect(runs).toBe(1)
        release(JSON.stringify(swapList()))
        expect((await a)!.accounts).toHaveLength(2)
        expect(await b).toBe(await a)
        clock += 59_000
        await reader.read()
        expect(runs).toBe(1)
        clock += 2_000
        const again = reader.read()
        expect(runs).toBe(2)
        release(JSON.stringify(swapList()))
        await again
    })

    test('a failure is kept as long as an answer: no login shell on every look', async () => {
        let clock = NOW
        let runs = 0
        const reader = new AgentSwapReader(() => {
            runs += 1
            return Promise.reject(new Error('exit 127'))
        }, () => clock)
        expect(await reader.read()).toBeNull()
        expect(await reader.read()).toBeNull()
        expect(runs).toBe(1)
        clock += 61_000
        expect(await reader.read()).toBeNull()
        expect(runs).toBe(2)
    })

    test('the login-shell runner: a missing command and a hung one both end', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't126-shell-'))
        const missing = path.join(dir, 'missing.sh')
        fs.writeFileSync(missing, '#!/bin/sh\nexit 127\n', { mode: 0o755 })
        const hung = path.join(dir, 'hung.sh')
        fs.writeFileSync(hung, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 })
        const answers = path.join(dir, 'answers.sh')
        fs.writeFileSync(answers, `#!/bin/sh\n[ "$1" = "-l" ] && [ "$2" = "-c" ] || exit 2\ncat <<'JSON'\n${JSON.stringify(swapList())}\nJSON\n`, { mode: 0o755 })
        await expect(runAgentSwapInLoginShell(missing)()).rejects.toThrow()
        const started = Date.now()
        await expect(runAgentSwapInLoginShell(hung, 500)()).rejects.toThrow()
        expect(Date.now() - started).toBeLessThan(5_000)
        expect(parseAgentSwapList(await runAgentSwapInLoginShell(answers)(), NOW)!.accounts).toHaveLength(2)
        fs.rmSync(dir, { recursive: true, force: true })
    })

    test("the app's own reading in the phone's shape", () => {
        const app = appUsageForPhone({
            claude: { fiveHour: { usedPercent: 30, resetsAt: Math.floor((NOW + HOUR) / 1000), windowMinutes: 300, label: '5h' }, updatedAt: NOW },
            codex: { weekly: { usedPercent: 55, resetsAt: null, windowMinutes: 10080, label: '7d' }, updatedAt: NOW }
        })
        expect(app).toEqual({ claude: { fiveHour: { usedPercent: 30, resetsAt: iso(HOUR) }, updatedAt: NOW }, codex: { weekly: { usedPercent: 55, resetsAt: null }, updatedAt: NOW } })
        expect(appUsageForPhone({})).toEqual({})
    })

    test('until a reset, in words', () => {
        expect(untilReset(iso(2 * HOUR + 12 * 60_000), NOW)).toBe('in 2h 12m')
        expect(untilReset(iso(50 * HOUR), NOW)).toBe('in 2d 2h')
        expect(untilReset(iso(5 * 60_000), NOW)).toBe('in 5m')
        expect(untilReset(iso(-1), NOW)).toBe('resetting')
        expect(untilReset(null, NOW)).toBeNull()
    })
})

// ---- the app ---------------------------------------------------------------------------------

const OWNER = 'owner-t126@example.com'
const PORT = 47926
const LABEL = process.env.T126_LABEL ?? 'run'

let result: LaunchResult | null = null
test.afterEach(async () => {
    if (!result) return
    const done = result
    result = null
    const closed = await Promise.race([closeApp(done).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000))])
    if (!closed) {
        done.app.process().kill('SIGKILL')
        fs.rmSync(done.userDataDir, { recursive: true, force: true })
    }
})

async function shot(page: Page, name: string): Promise<void> {
    const dir = process.env.T126_SHOTS
    if (!dir) return
    fs.mkdirSync(dir, { recursive: true })
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(dir, `${name}-${LABEL}.png`) })
}

async function openPhone(app: ElectronApplication, url: string): Promise<{ phone: Page; cdp: CDPSession }> {
    const opened = app.waitForEvent('window')
    await app.evaluate(({ BrowserWindow, session }, o) => {
        const jar = session.fromPartition('t126-phone')
        jar.webRequest.onBeforeSendHeaders((details, callback) => {
            callback({ requestHeaders: { ...details.requestHeaders, 'Tailscale-User-Login': o.owner, 'X-Forwarded-For': '100.101.102.103' } })
        })
        const win = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false, webPreferences: { partition: 't126-phone', backgroundThrottling: false } })
        void win.loadURL(o.url)
    }, { url, owner: OWNER })
    const phone = await opened
    await phone.waitForLoadState('domcontentloaded')
    const cdp = await phone.context().newCDPSession(phone)
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } })
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await phone.reload()
    await phone.waitForLoadState('domcontentloaded')
    return { phone, cdp }
}

async function tap(cdp: CDPSession, page: Page, selector: string): Promise<void> {
    const box = await page.locator(selector).first().boundingBox()
    expect(box, selector).not.toBeNull()
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }] })
    await page.waitForTimeout(60)
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

test('T126 phone: ☰ → Usage shows agent-swap accounts over the chat, read once a minute (3b4efdfc)', async () => {
    test.setTimeout(150_000)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t126-'))
    const project = path.join(home, 'project')
    fs.mkdirSync(project, { recursive: true })
    const statusFile = path.join(home, 'tailscale-status.json')
    fs.writeFileSync(statusFile, JSON.stringify({ BackendState: 'Running', Self: { UserID: 42, DNSName: 'mac.tail1234.ts.net.', TailscaleIPs: ['100.100.1.1'] }, User: { '42': { LoginName: OWNER } } }))
    // the fake stands in for the login shell: it answers `-l -c …` with made-up accounts and counts its runs.
    // Times are relative to now so «resets in …» reads sensibly.
    const list = swapList()
    const shift = Date.now() - NOW
    const moved = JSON.parse(JSON.stringify(list), (key, value) => (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) ? new Date(Date.parse(value) + shift).toISOString() : key === 'resetsAt' && typeof value === 'number' ? value + Math.floor(shift / 1000) : value))
    const json = path.join(home, 'aswap.json')
    fs.writeFileSync(json, JSON.stringify(moved))
    const runs = path.join(home, 'runs.txt')
    const fake = path.join(home, 'fake-shell.sh')
    fs.writeFileSync(fake, `#!/bin/sh\necho run >> '${runs}'\ncat '${json}'\n`, { mode: 0o755 })
    result = await launchAppWithWorkspaces(
        [{ id: 'w-t126', name: 'T126 project', path: project, sessions: [{ id: 't126-shell', name: 'T126 Shell' }] }],
        { settings: { phone: { enabled: true, port: PORT } }, env: { CLIMANAGER_PHONE_TAILSCALE_STATUS: statusFile, CLIMANAGER_AGENT_SWAP_FAKE: fake, CODEX_HOME: path.join(home, 'codex'), CLIMANAGER_HOME: path.join(home, 'climanager') } }
    )
    const { app, page } = result
    const state = await page.evaluate(() => window.api.getPhoneState())
    expect(state.running).toBe(true)
    const { phone, cdp } = await openPhone(app, `http://127.0.0.1:${state.port}/?session=t126-shell&view=terminal`)
    await expect(phone.getByTestId('phone-session')).toBeVisible({ timeout: 15_000 })
    await shot(phone, 't126-phone-before-390')
    expect(fs.existsSync(runs), 'nothing asks agent-swap until the view opens').toBe(false)

    await tap(cdp, phone, '[data-testid="phone-menu-button"]')
    await tap(cdp, phone, '[data-testid="phone-usage-entry"]')
    const panel = phone.getByTestId('phone-usage-panel')
    await expect(panel).toBeVisible()
    await expect(phone.getByTestId('phone-usage-account')).toHaveCount(2)
    const first = phone.getByTestId('phone-usage-account').first()
    await expect(first).toContainText('fi…@example.com')
    await expect(first).toContainText('active')
    await expect(first.getByTestId('phone-usage-account-5h')).toHaveAttribute('data-used', '42')
    await expect(first.getByTestId('phone-usage-account-7d')).toHaveAttribute('data-used', '91')
    await expect(first.getByTestId('phone-usage-runs-out')).toContainText('Runs out in')
    await expect(phone.getByTestId('phone-usage-account').nth(1)).toContainText('work')
    await expect(phone.getByTestId('phone-usage-swap-codex-secondary')).toHaveAttribute('data-used', '63')
    // a fresh Mac: the app has read nothing of its own yet (CODEX_HOME is a temp folder)
    await expect(phone.getByTestId('phone-usage-codex')).toHaveCount(0)
    expect(await panel.textContent()).not.toContain('first.person')
    await shot(phone, 't126-phone-usage-390')
    // drawn on top: toBeVisible also passes for an element under the chat
    const onTop = await phone.evaluate(() => {
        const r = document.querySelector('[data-testid="phone-usage-panel"]')!.getBoundingClientRect()
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('[data-testid="phone-usage-panel"]') !== null
    })
    expect(onTop, 'the usage view is over the session').toBe(true)
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll').toBe(true)
    const box = (await panel.boundingBox())!
    expect(box.x + box.width).toBeLessThanOrEqual(391)

    // ↻ inside a minute: the Mac answers from what it read, agent-swap runs once
    await tap(cdp, phone, '[data-testid="phone-usage-refresh"]')
    await expect(phone.getByTestId('phone-usage-account')).toHaveCount(2)
    expect(fs.readFileSync(runs, 'utf8').trim().split('\n')).toHaveLength(1)

    await tap(cdp, phone, '[data-testid="phone-usage-close"]')
    await expect(panel).toHaveCount(0)
    await expect(phone.getByTestId('phone-session')).toBeVisible()
})
