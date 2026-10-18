import { test, expect, Page } from '@playwright/test'
import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, REPO_ROOT, waitForBufferText, writeToTerminal } from './helpers'
import { maskSecretLines, MASK } from '../../src/main/maskSecrets'
import { TerminalEventLog } from '../../src/main/TerminalEventLog'
import { buildFeedbackTerminalContext, FeedbackTerminalSources } from '../../src/main/feedbackTerminalContext'
import { terminalExtra, withTerminalEvents } from '../../src/renderer/src/components/Feedback/terminalContext'
import type { TerminalManager } from '../../src/main/TerminalManager'
import type { FeedbackTerminalContext } from '../../src/shared/types'

/**
 * T32 — what a feedback report carries about terminals.
 *
 * Every report from the widget carries the terminal it is about (picked, focused or the only one
 * on screen): its state, its last lines with secrets masked, and recent events — renderer crashes,
 * a program erasing the scrollback (CSI 3 J), Cmd+K, exits. The units run in-process; the app
 * tests judge at the ends: main's IPC answer for a real pty, and the payload the widget actually
 * hands to the relay (main's fetch is replaced, so nothing reaches Lasso Run).
 */

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

/**
 * Fake credentials, assembled at run time: the repository's secret scan (pnpm check:publish)
 * rejects credential-shaped literals in tracked files, test fixtures included.
 */
const SK = ['s', 'k-'].join('')
const GHP = ['gh', 'p_'].join('')
const PRIVATE_KEY_LINE = (edge: 'BEGIN' | 'END'): string => `-----${edge} OPENSSH ${['PRIV', 'ATE'].join('')} KEY-----`

test.describe('T32 units', () => {
    test('masks vendor tokens, secret assignments, auth headers, URL passwords and private keys', () => {
        // One line per call: adjacent rows that touch mid-token are judged together (next test).
        const one = (line: string): string => maskSecretLines([line]).lines[0]
        expect(one(`key ${SK}ant-api03-abcdefghijklmnopqrstuvwx done`)).toBe(`key ${MASK} done`)
        expect(one(`export GITHUB_TOKEN=${GHP}abcdefghijklmnopqrstuvwxyz0123`)).toBe(`export GITHUB_TOKEN=${MASK}`)
        expect(one('DATABASE_PASSWORD="hunter2hunter2"')).toBe(`DATABASE_PASSWORD="${MASK}"`)
        expect(one('{"apiKey": "plainvalue1234"}')).toBe(`{"apiKey": "${MASK}"}`)
        expect(one('Authorization: Bearer abcdefghijklmnop.qrstuv')).toBe(`Authorization: Bearer ${MASK}`)
        expect(one('psql postgres://admin:s3cretpass@db.example.com/app')).toBe(`psql postgres://admin:${MASK}@db.example.com/app`)
        const key = maskSecretLines([
            PRIVATE_KEY_LINE('BEGIN'),
            'b3BlbnNzaC1rZXktdjEAAAAA',
            PRIVATE_KEY_LINE('END'),
            '$ after the key'
        ])
        expect(key.lines).toEqual([MASK, MASK, MASK, '$ after the key'])
        expect(key.masked).toBe(3)
    })

    test('a secret cut at the right edge is masked whole; rows without one keep their shape', () => {
        // zsh breaks a long typed command itself, so the terminal marks no wrap — and after a resize no width tells.
        const { lines, masked } = maskSecretLines([
            `% echo ${SK}ant-t32a`,
            'bcdefghijklmnopqrstu done',
            '% export API_TO',
            'KEN=abcd1234',
            `% printf "${SK}ant-t32abcdefghijklmn`,
            'opqrstu"',
            'build',
            'ok'
        ])
        expect(lines).toEqual([`% echo ${MASK} done`, `% export API_TOKEN=${MASK}`, `% printf "${MASK}"`, 'build', 'ok'])
        expect(masked).toBe(3)

        // The price of not knowing: a secret that merely ended at the row end takes the next word with it.
        expect(maskSecretLines(['% export API_TOKEN=abcd1234', 'done in 2s']).lines).toEqual([`% export API_TOKEN=${MASK} in 2s`])
        // A join that would hide less is not made: here it would glue the account name to the output.
        expect(maskSecretLines(['T32-STEP-1002', 'tester@mac ~ %'], { username: 'tester' }).lines).toEqual(['T32-STEP-1002', 'user@mac ~ %'])
    })

    test('leaves ordinary terminal text alone and hides the account folder', () => {
        const plain = ['Running 12 tests using 1 worker', "git commit -m 'basic usage'", '↓ 1.2k tokens · esc to interrupt']
        expect(maskSecretLines(plain)).toEqual({ lines: plain, masked: 0 })
        const { lines } = maskSecretLines(
            ['tester@mac ~/repo % ls /Users/tester/repo', 'testers wrote this'],
            { homeDir: '/Users/tester', username: 'tester' }
        )
        expect(lines).toEqual(['user@mac ~/repo % ls ~/repo', 'testers wrote this'])
    })

    test('event log: collapses quick repeats, keeps a bound, forgets deleted sessions', () => {
        let now = Date.parse('2026-10-18T00:00:00Z')
        const bus = new EventEmitter()
        const log = new TerminalEventLog({ events: bus } as unknown as TerminalManager, () => now)

        bus.emit('created', 's1', 80, 24)
        for (let i = 0; i < 4; i++) {
            log.record('s1', 'scrollback-erased')
            now += 1000
        }
        now += 10_000
        log.record('s1', 'scrollback-erased')
        bus.emit('attached', 's1', false)
        bus.emit('attached', 's1', true)
        bus.emit('exited', 's1', { by: 'program', exitCode: 3 })
        bus.emit('exited', 's1', { by: 'app' })

        const events = log.events('s1')
        expect(events.map((e) => e.kind)).toEqual(['started', 'scrollback-erased', 'scrollback-erased', 'reattached', 'exited', 'closed'])
        expect(events[1].count).toBe(4)
        expect(events[2].count).toBeUndefined()
        expect(events[4].detail).toBe('exit code 3')

        for (let i = 0; i < 50; i++) {
            now += 10_000
            log.record('s1', 'cleared')
        }
        expect(log.events('s1')).toHaveLength(30)

        for (let i = 0; i < 250; i++) log.record(`t${i}`, 'started')
        expect(log.events('t0')).toEqual([])
        expect(log.events('t249')).toHaveLength(1)

        log.forget('t249')
        expect(log.events('t249')).toEqual([])
    })

    test('context: unknown or malformed ids carry window events only; known ones are masked', async () => {
        const log = new TerminalEventLog()
        log.recordApp('renderer-gone', 'crashed (exit code 5)')
        log.record('s1', 'started')
        const sources: FeedbackTerminalSources = {
            terminals: { hasTerminal: (id: string) => id === 's1' },
            mirror: {
                has: (id: string) => id === 's1',
                flush: async () => {},
                logicalTail: () => ['$ echo API_SECRET=abcd1234', '$ ok'],
                lineCount: () => 42,
                size: () => ({ cols: 80, rows: 24 }),
                lastOutputAt: () => Date.parse('2026-10-18T01:02:03Z'),
                hasExited: () => false,
                showsBusy: () => true,
                showsAwaitingInput: () => false
            },
            log,
            agentStatus: () => 'running',
            mask: {}
        }
        for (const id of [null, 42, '', 'x'.repeat(200), 'unknown']) {
            const ctx = await buildFeedbackTerminalContext(id, sources)
            expect(ctx.terminal).toBeNull()
            expect(ctx.appEvents.map((e) => e.kind)).toEqual(['renderer-gone'])
        }
        const ctx = await buildFeedbackTerminalContext('s1', sources)
        expect(ctx.terminal).toMatchObject({
            sessionId: 's1',
            running: true,
            historyLines: 42,
            screen: 'busy',
            agentStatus: 'running',
            lastOutputAt: '2026-10-18T01:02:03.000Z',
            recentLines: [`$ echo API_SECRET=${MASK}`, '$ ok'],
            maskedCount: 1
        })
    })

    test('renderer side: events become app log entries by severity; extra carries the state only', () => {
        const context: FeedbackTerminalContext = {
            appEvents: [{ kind: 'renderer-gone', at: '2026-10-18T00:00:02.000Z', detail: 'crashed (exit code 5)' }],
            terminal: {
                sessionId: 's1', running: true, size: { cols: 80, rows: 24 }, historyLines: 3, lastOutputAt: null,
                screen: 'idle', agentStatus: null, recentLines: ['a'], maskedCount: 0,
                events: [
                    { kind: 'started', at: '2026-10-18T00:00:01.000Z' },
                    { kind: 'scrollback-erased', at: '2026-10-18T00:00:03.000Z', count: 2 },
                    { kind: 'exited', at: '2026-10-18T00:00:04.000Z', detail: 'exit code 0' },
                    { kind: 'exited', at: '2026-10-18T00:00:05.000Z', detail: 'exit code 1' }
                ]
            }
        }
        const diagnostics = withTerminalEvents({ network: [], logs: [{ level: 'warn', message: 'console', at: '2026-10-18T00:00:00.000Z' }], routes: [] }, context)
        expect(diagnostics?.logs.map((l) => [l.level, l.message])).toEqual([
            ['warn', 'console'],
            ['log', '[terminal] started'],
            ['error', '[app] renderer-gone (crashed (exit code 5))'],
            ['warn', '[terminal] scrollback-erased ×2'],
            ['log', '[terminal] exited (exit code 0)'],
            ['error', '[terminal] exited (exit code 1)']
        ])
        expect(withTerminalEvents(null, null)).toBeNull()

        const extra = terminalExtra({ sessionId: 's1', source: 'picked' }, context) as { terminal: Record<string, unknown> }
        expect(extra.terminal.source).toBe('picked')
        expect(extra.terminal.recentLines).toEqual(['a'])
        expect(extra.terminal).not.toHaveProperty('events')
        expect(terminalExtra({ sessionId: 'gone', source: 'focused' }, { appEvents: [], terminal: null }))
            .toEqual({ terminal: { sessionId: 'gone', source: 'focused', known: false } })
        expect(terminalExtra(null, null)).toEqual({})
    })
})

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const SESSION = 's-t32'
const FLOATING_BUTTON = '#feedback-kit-floating-button'
const GATE_SOURCE = path.join(REPO_ROOT, 'src/renderer/src/utils/feedbackGate.ts')
const RENDERER_ASSETS = path.join(REPO_ROOT, 'out/renderer/assets')
const FEEDBACK_BUNDLE_MARKER = 'dp-agentation-ingest/'
const FAKE_SECRET = 't32supersecretvalue'
const FAKE_VENDOR_KEY = `${SK}ant-t32abcdefghijklmnopqrstu`

function buildHasFeedback(): boolean {
    if (!fs.existsSync(RENDERER_ASSETS)) return false
    return fs.readdirSync(RENDERER_ASSETS)
        .filter((name) => name.endsWith('.js'))
        .some((name) => fs.readFileSync(path.join(RENDERER_ASSETS, name), 'utf-8').includes(FEEDBACK_BUNDLE_MARKER))
}

function terminalContext(page: Page, id: string | null): Promise<FeedbackTerminalContext> {
    return page.evaluate((sessionId) => window.api.feedbackTerminalContext(sessionId), id)
}

/**
 * Runs a command and waits for its output. The marker is computed by the shell (`$((n+1))`), so it
 * appears only in the output — the typed command line alone would satisfy a plain marker too early.
 */
async function run(page: Page, command: string, step: number): Promise<void> {
    await writeToTerminal(page, SESSION, `${command}; echo T32-STEP-$((${step}+1000))\r`)
    await waitForBufferText(page, SESSION, `T32-STEP-${step + 1000}`, 20_000)
}

/**
 * Prints a marker, clears like Cmd+K, erases the scrollback, and prints secrets — in that order.
 * One copy of the vendor key is printed 5 columns before the right edge, so the terminal wraps it
 * in two: masking line by line would miss both halves (it did, in the first live report).
 */
async function produceHistory(page: Page): Promise<void> {
    await run(page, 'echo T32-READY', 1)
    await page.evaluate((id) => window.api.clearTerminal(id), SESSION)
    await run(page, "printf '\\033[3J'", 2)
    await run(page, `echo "T32-SECRET API_TOKEN=${FAKE_SECRET} ${FAKE_VENDOR_KEY}"; echo "$HOME/T32-HOME"`, 3)
    await run(page, `printf "%$((COLUMNS-5))s%s\\n" "" "${FAKE_VENDOR_KEY}"`, 5)
}

/** Neither the whole key nor a piece of it that a wrap would leave behind. */
function expectNoVendorKey(text: string): void {
    expect(text).not.toContain(FAKE_VENDOR_KEY.slice(0, 10))
    expect(text).not.toContain(FAKE_VENDOR_KEY.slice(-7))
}

/** The account running the tests must not show up — the prompt and paths carry it. */
function expectNoAccount(text: string): void {
    expect(text).not.toContain(`${os.userInfo().username}@`)
    expect(text).not.toContain(os.homedir())
}

/** Unlocks the widget (remembered unlock, as in T31), shows the session, arms pick mode and picks its terminal. */
async function pickTerminal(page: Page): Promise<void> {
    const source = fs.readFileSync(GATE_SOURCE, 'utf-8')
    const hash = /FEEDBACK_PASSWORD_HASH = '([0-9a-f]{64})'/.exec(source)?.[1]
    const storageKey = /UNLOCK_STORAGE_KEY = '([^']+)'/.exec(source)?.[1]
    if (!hash || !storageKey) throw new Error('feedbackGate.ts constants not found')
    await page.evaluate(([key, value]) => localStorage.setItem(key, value), [storageKey, hash])
    await page.reload()
    await page.getByText('T32CONTEXT').first().waitFor({ timeout: 30_000 })
    const button = page.locator(FLOATING_BUTTON)
    await expect(button).toBeVisible({ timeout: 15_000 })
    // After a reload no session is active; the terminal stays hidden until one is chosen.
    await page.locator(`[data-session-item="${SESSION}"]`).click()
    await expect.poll(() => page.locator(`[data-session-id="${SESSION}"]`).evaluate((el) => getComputedStyle(el).visibility))
        .toBe('visible')

    // Pick mode is the default: the first press arms it, the next click picks the terminal.
    // A raw mouse click — the picker may cover the page, which Playwright's locator click refuses.
    await button.click()
    const box = await page.locator(`[data-session-id="${SESSION}"]`).boundingBox()
    if (!box) throw new Error('terminal container has no box')
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 3)
}

/** Picking opens the element note, not the whole-screen dialog. */
async function sendNote(page: Page, comment: string): Promise<void> {
    await page.getByRole('textbox', { name: '이 요소에 남길 의견' }).fill(comment)
    await page.getByRole('button', { name: '보내기', exact: true }).click()
}

test.describe('T32 app', () => {
    let ctx: LaunchResult | undefined

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
    })

    const launch = () => launchAppWithWorkspaces([{ id: 'ws-t32', name: 'T32CONTEXT', sessions: [{ id: SESSION, name: 'T32SESS' }] }])

    test('main reports a real terminal: tail masked, events in order, exit code', async () => {
        ctx = await launch()
        const { page } = ctx
        await produceHistory(page)

        const context = await terminalContext(page, SESSION)
        const terminal = context.terminal
        expect(terminal, 'a running session is known to main').not.toBeNull()
        const text = terminal!.recentLines.join('\n')
        expect(text).toContain('T32-SECRET')
        expect(text).not.toContain(FAKE_SECRET)
        expectNoVendorKey(text)
        expectNoAccount(text)
        expect(terminal!.maskedCount, 'secret, key in the output, key typed twice, wrapped key').toBeGreaterThanOrEqual(5)
        expect(text, 'the home folder is shown as ~').toContain('~/T32-HOME')
        expect(text, 'Cmd+K cleared what came before').not.toContain('echo T32-READY')
        expect(terminal!.running).toBe(true)
        expect(terminal!.historyLines).toBeGreaterThan(0)
        expect(terminal!.size?.cols).toBeGreaterThan(0)
        const kinds = terminal!.events.map((e) => e.kind)
        expect(kinds.indexOf('started')).toBeGreaterThanOrEqual(0)
        expect(kinds.indexOf('cleared')).toBeGreaterThan(kinds.indexOf('started'))
        expect(kinds.indexOf('scrollback-erased')).toBeGreaterThan(kinds.indexOf('cleared'))

        await writeToTerminal(page, SESSION, 'exit 3\r')
        await expect.poll(async () => (await terminalContext(page, SESSION)).terminal?.events.at(-1), { timeout: 10_000 })
            .toMatchObject({ kind: 'exited', detail: 'exit code 3' })
        expect((await terminalContext(page, SESSION)).terminal?.running).toBe(false)

        expect((await terminalContext(page, 'no-such-session')).terminal).toBeNull()
        expect((await terminalContext(page, null)).terminal).toBeNull()
    })

    test('a renderer crash is recorded for the window and as a reattach for the terminal', async () => {
        ctx = await launch()
        const { app, page } = ctx
        await run(page, 'echo T32-BEFORE-CRASH', 4)

        const reloaded = app.evaluate(({ BrowserWindow }) => new Promise<void>((done) => {
            BrowserWindow.getAllWindows()[0].webContents.once('did-finish-load', () => done())
        }))
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer())
        await reloaded

        // Playwright treats the crashed page as dead after the reload; ask the reloaded renderer through main.
        const contextAfter = (): Promise<FeedbackTerminalContext> => app.evaluate(({ BrowserWindow }, id) =>
            BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(`window.api.feedbackTerminalContext(${JSON.stringify(id)})`), SESSION)
        await expect.poll(async () => (await contextAfter()).terminal?.events.some((e) => e.kind === 'reattached'), { timeout: 30_000 })
            .toBe(true)
        const context = await contextAfter()
        expect(context.appEvents.map((e) => e.kind)).toEqual(['renderer-gone', 'renderer-reloaded'])
        expect(context.appEvents[0].detail).toMatch(/exit code/)
        expect(context.terminal!.recentLines.join('\n'), 'history survived in main').toContain('T32-BEFORE-CRASH')
    })

    test('a report sent from the widget carries the picked terminal and its events', async () => {
        test.skip(!buildHasFeedback(), 'build has no VITE_DP_FEEDBACK_URL/KEY')
        ctx = await launch()
        const { app, page } = ctx

        // Main's fetch answers for the ingest, so the payload is captured and nothing leaves the machine.
        await app.evaluate(() => {
            const g = globalThis as unknown as { fetch: typeof fetch; __t32Bodies: string[] }
            const original = g.fetch
            g.__t32Bodies = []
            g.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
                if (!String(input).includes('/functions/v1/dp-agentation-ingest/')) return original(input, init)
                // The hint catalog (GET) is optional for the widget; it gives up quietly.
                if (init?.method !== 'POST') return new Response('{}', { status: 404 })
                g.__t32Bodies.push(String(init.body ?? ''))
                return new Response(JSON.stringify({ ok: true, annotationId: 't32' }), {
                    status: 201,
                    headers: { 'content-type': 'application/json' }
                })
            }) as typeof fetch
        })

        await produceHistory(page)
        await pickTerminal(page)
        await sendNote(page, '[t32] terminal context check')
        await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __t32Bodies: string[] }).__t32Bodies.length), { timeout: 30_000 })
            .toBe(1)

        const bodies = await app.evaluate(() => (globalThis as unknown as { __t32Bodies: string[] }).__t32Bodies)
        expect(bodies).toHaveLength(1)
        const payload = JSON.parse(bodies[0]) as {
            report: { logs: Array<{ level: string; message: string }>; context: { extra: Record<string, any> } }
        }
        const terminal = payload.report.context.extra.terminal
        expect(terminal).toMatchObject({ sessionId: SESSION, source: 'picked', running: true })
        expect(payload.report.context.extra.appVersion).toBeTruthy()
        const tail = (terminal.recentLines as string[]).join('\n')
        expect(tail).toContain('T32-SECRET')
        expect(tail).not.toContain(FAKE_SECRET)
        expectNoVendorKey(tail)
        expectNoAccount(tail)
        const messages = payload.report.logs.map((l) => l.message)
        expect(messages).toContain('[terminal] started')
        expect(messages).toContain('[terminal] cleared')
        expect(messages.some((m) => m.startsWith('[terminal] scrollback-erased'))).toBe(true)
        expect(messages.some((m) => m.startsWith('[terminal] reattached')), 'the reload re-attached the view').toBe(true)
    })

    test('live: a picked-terminal report reaches Lasso Run with its terminal context', async () => {
        test.skip(process.env.FEEDBACK_LIVE !== '1', 'set FEEDBACK_LIVE=1 to send a real report')
        test.skip(!buildHasFeedback(), 'build has no VITE_DP_FEEDBACK_URL/KEY')
        ctx = await launch()
        const { page } = ctx
        await produceHistory(page)
        await pickTerminal(page)
        const marker = `[t32-live:${randomUUID()}]`
        await sendNote(page, `${marker} terminal context relay check`)
        // A picked note reports through its own status line, not the whole-screen toast.
        await expect(page.getByRole('status', { name: marker })).toHaveText(/완료/, { timeout: 30_000 })
        console.log(`T32 live marker: ${marker}`)
    })
})
