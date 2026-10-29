import { test, expect, Page } from '@playwright/test'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, writeToTerminal, saveMetrics, LaunchResult, REPO_ROOT, SeedWorkspace } from './helpers'

/**
 * T68 — what the sidebar status costs, in the app (fb-1029b · d499aed0). Opt-in:
 * STATUS_PERF=1 pnpm test:term t68 (about 5 minutes; numbers in results/<label>/t68-*.json).
 *
 * Forty sessions like the user's sidebar: 4 agents mid-turn, 2 showing a
 * question, 30 agents sitting at their prompt, 4 shells printing logs. One more
 * plain shell is on screen. Each agent prints "Claude Code v…" first so the old
 * renderer heuristic recognises it (it skips anything else — a benchmark
 * without it reads ~90x too cheap, see CLAUDE.md "성능").
 *
 * Two loads: steady (the 4 agents stay mid-turn — statuses never change) and
 * churn (each of the 4 runs a 2.5s turn every 5s, so dots flip on and off the
 * way they do when agents work — this is where a status change costs IPC and
 * renders).
 *
 * Three setups, same load:
 *   off       — the user's config: Settings > Hooks off, new dots off
 *   heuristic — Settings > Hooks "Session Monitoring" on (the existing feature)
 *   screen    — the new "Show Session Status" (main reads the mirrors)
 *
 * Per setup: main and renderer CPU over 30s (app.getAppMetrics), status IPC
 * per minute both ways, main's tick time (screen only), then — after a reload
 * with a React DevTools hook installed — React commits and sidebar-row renders
 * per minute. CPU is measured before the hook goes in; walking the fiber tree
 * on every commit costs renderer time of its own.
 */

const RUN = process.env.STATUS_PERF === '1'
const WINDOW_MS = Number(process.env.STATUS_PERF_WINDOW_MS ?? 30_000)
const WARMUP_MS = 8_000
const BANNER = `printf 'Claude Code v2.1.312\\n'`
const AGENT = `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --box`
const IDLE_SCREEN = `printf 'Claude Code v2.1.312\\n\\n● Done.\\n────────\\n❯ \\n────────\\n'`

const HOME = 'p-home'
const working = Array.from({ length: 4 }, (_, i) => `p-work-${i}`)
const asking = Array.from({ length: 2 }, (_, i) => `p-ask-${i}`)
const idle = Array.from({ length: 30 }, (_, i) => `p-idle-${i}`)
const logs = Array.from({ length: 4 }, (_, i) => `p-logs-${i}`)

type Load = 'steady' | 'churn'
const CHURN_TURN_MS = 2500
const CHURN_EVERY_MS = 5000

function seed(load: Load): SeedWorkspace[] {
    const workMs = load === 'churn' ? CHURN_TURN_MS : 600_000
    const sessions = [
        { id: HOME, name: 'perf home' },
        ...working.map((id, i) => ({ id, name: `working ${i}`, initialCommand: `${BANNER}; ${AGENT} --work-ms ${workMs}` })),
        ...asking.map((id, i) => ({ id, name: `asking ${i}`, initialCommand: `${BANNER}; ${AGENT}` })),
        ...idle.map((id, i) => ({ id, name: `idle agent ${i}`, initialCommand: IDLE_SCREEN })),
        ...logs.map((id, i) => ({ id, name: `logs ${i}`, initialCommand: 'while true; do echo "GET /api/x 200 $RANDOM"; sleep 0.5; done' }))
    ]
    // Four projects of ~10, the way the user's sidebar spreads sessions over folders.
    const workspaces: SeedWorkspace[] = []
    for (let i = 0; i < sessions.length; i += 11) {
        workspaces.push({ id: `p-w${i}`, name: `perf project ${i / 11}`, sessions: sessions.slice(i, i + 11) })
    }
    return workspaces
}

type Setup = 'off' | 'heuristic' | 'screen'

function settingsFor(setup: Setup): Record<string, unknown> {
    return {
        hooks: {
            enabled: setup === 'heuristic',
            claudeCode: { enabled: true, detectRunning: true, detectReady: true, detectError: false, showInSidebar: true, autoDismissSeconds: 5 }
        },
        showSessionStatus: setup === 'screen'
    }
}

/** Counts status IPC in main, both directions. */
async function installIpcCounters(ctx: LaunchResult): Promise<void> {
    await ctx.app.evaluate(({ BrowserWindow, ipcMain }) => {
        const g = globalThis as unknown as { __perfIpc: Record<string, number> }
        g.__perfIpc = {}
        const bump = (name: string) => { g.__perfIpc[name] = (g.__perfIpc[name] ?? 0) + 1 }
        for (const win of BrowserWindow.getAllWindows()) {
            const original = win.webContents.send.bind(win.webContents)
            win.webContents.send = (channel: string, ...args: unknown[]) => {
                if (channel === 'agent-status-update' || channel === 'session-screen-status') bump(`main→renderer ${channel}`)
                return original(channel, ...args)
            }
        }
        ipcMain.on('agent-status-observed', () => bump('renderer→main agent-status-observed'))
    })
}

async function readIpc(ctx: LaunchResult): Promise<Record<string, number>> {
    return ctx.app.evaluate(() => ({ ...(globalThis as unknown as { __perfIpc: Record<string, number> }).__perfIpc }))
}

async function cpu(ctx: LaunchResult): Promise<{ main: number; renderer: number; gpu: number }> {
    return ctx.app.evaluate(({ app }) => {
        const out = { main: 0, renderer: 0, gpu: 0 }
        for (const m of app.getAppMetrics()) {
            if (m.type === 'Browser') out.main += m.cpu.percentCPUUsage
            else if (m.type === 'Tab') out.renderer += m.cpu.percentCPUUsage
            else if (m.type === 'GPU') out.gpu += m.cpu.percentCPUUsage
        }
        return out
    })
}

/**
 * A minimal React DevTools hook. Counts commits, App renders and sidebar-row
 * renders. Rows are found by their props (names are minified in the build).
 * A fiber rendered in a commit if it is a new object at its position (React
 * swaps the pair when it visits a fiber) and carries PerformedWork.
 */
const RENDER_HOOK = `(() => {
    const PERFORMED_WORK = 1
    const stats = { commits: 0, appRenders: 0, rowRenders: 0 }
    const lastRow = new Map()
    let lastApp = null
    window.__perfRenders = stats
    window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
        supportsFiber: true,
        renderers: new Map(),
        inject(renderer) { const id = this.renderers.size + 1; this.renderers.set(id, renderer); return id },
        onScheduleFiberRoot() {},
        onCommitFiberRoot(_id, root) {
            stats.commits++
            const stack = [root.current]
            let sawApp = false
            while (stack.length) {
                const fiber = stack.pop()
                if (!fiber) continue
                const props = fiber.memoizedProps
                if (fiber.tag === 0 && !sawApp) {
                    sawApp = true
                    if (fiber !== lastApp && (fiber.flags & PERFORMED_WORK)) stats.appRenders++
                    lastApp = fiber
                }
                if (fiber.tag === 0 && props && props.session && props.workspace && typeof props.onRename === 'function') {
                    const key = props.session.id
                    if (lastRow.get(key) !== fiber && (fiber.flags & PERFORMED_WORK)) stats.rowRenders++
                    lastRow.set(key, fiber)
                }
                if (fiber.sibling) stack.push(fiber.sibling)
                if (fiber.child) stack.push(fiber.child)
            }
        },
        onPostCommitFiberRoot() {},
        onCommitFiberUnmount() {},
        checkDCE() {},
        isDisabled: false
    }
})()`

async function startLoad(page: Page): Promise<void> {
    await page.locator(`[data-session-item="${HOME}"]`).first().click()
    // All sessions: every row is on screen, the way the user's sidebar is.
    await page.getByTestId('sidebar-view-toggle').click()
    await expect.poll(() => page.evaluate((id) => (window as unknown as { __termDebug: { text: (id: string) => string } }).__termDebug.text(id), asking[1]), { timeout: 30_000 }).toContain('❯')
    for (const id of working) await writeToTerminal(page, id, 'go\r')
    for (const id of asking) await writeToTerminal(page, id, 'ASK\r')
}

/** Churn: a new turn for each working agent every CHURN_EVERY_MS, staggered. Survives the reload. */
function startChurn(page: Page): () => void {
    let n = 0
    const timer = setInterval(() => {
        const id = working[n++ % working.length]
        // The old heuristic only judges terminals it saw print "Claude Code v…" live — a reload
        // replays history without feeding it — so each prompt carries the banner text (the mock echoes it).
        void writeToTerminal(page, id, `go Claude Code v2.1.312 ${n}\r`).catch(() => {})
    }, CHURN_EVERY_MS / working.length)
    return () => clearInterval(timer)
}

async function measure(setup: Setup, load: Load): Promise<Record<string, unknown>> {
    const ctx = await launchAppWithWorkspaces(seed(load), { settings: settingsFor(setup) })
    let stopChurn = () => {}
    try {
        const { page } = ctx
        await startLoad(page)
        if (load === 'churn') stopChurn = startChurn(page)
        await page.waitForTimeout(WARMUP_MS)

        // 1) CPU and IPC, no instrumentation in the renderer.
        await installIpcCounters(ctx)
        await ctx.app.evaluate(() => { (globalThis as { __sessionScreenStatusTicks?: unknown[] }).__sessionScreenStatusTicks = [] })
        await cpu(ctx) // starts the averaging window
        await page.waitForTimeout(WINDOW_MS)
        const cpuAvg = await cpu(ctx)
        const ipc = await readIpc(ctx)
        const ticks = await ctx.app.evaluate(() => (globalThis as { __sessionScreenStatusTicks?: Array<{ ms: number; sessions: number }> }).__sessionScreenStatusTicks ?? [])
        const dots = await page.locator('[data-session-status]').count()
        const oldBadges = await page.locator('[data-session-item] .rounded-full.w-2.h-2').count()

        // 2) React renders, after a reload with the DevTools hook in place.
        await ctx.app.context().addInitScript(RENDER_HOOK)
        await page.reload()
        await page.locator(`[data-session-item="${HOME}"]`).first().waitFor({ timeout: 30_000 })
        await page.waitForTimeout(WARMUP_MS)
        await page.evaluate(() => {
            const s = (window as unknown as { __perfRenders: Record<string, number> }).__perfRenders
            s.commits = 0; s.appRenders = 0; s.rowRenders = 0
        })
        await page.waitForTimeout(WINDOW_MS)
        const renders = await page.evaluate(() => ({ ...(window as unknown as { __perfRenders: Record<string, number> }).__perfRenders }))

        const perMinute = (n: number) => Math.round((n * 60_000) / WINDOW_MS)
        const sorted = ticks.map((t) => t.ms).sort((a, b) => a - b)
        const result = {
            setup,
            load,
            sessions: 1 + working.length + asking.length + idle.length + logs.length,
            windowMs: WINDOW_MS,
            cpuPercent: { main: +cpuAvg.main.toFixed(2), renderer: +cpuAvg.renderer.toFixed(2), gpu: +cpuAvg.gpu.toFixed(2) },
            ipcPerMinute: Object.fromEntries(Object.entries(ipc).map(([k, v]) => [k, perMinute(v)])),
            ticks: sorted.length
                ? { count: sorted.length, medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(3), maxMs: +sorted[sorted.length - 1].toFixed(3), sessions: ticks[0].sessions }
                : { count: 0 },
            reactPerMinute: { commits: perMinute(renders.commits), appRenders: perMinute(renders.appRenders), rowRenders: perMinute(renders.rowRenders) },
            shownOnScreen: { newDots: dots, oldBadges }
        }
        saveMetrics(`t68-${setup}-${load}`, result)
        console.log(`[T68] ${JSON.stringify(result)}`)
        return result
    } finally {
        stopChurn()
        await closeApp(ctx)
    }
}

test.describe('T68 sidebar status cost', () => {
    test.skip(!RUN, 'opt-in: STATUS_PERF=1')
    test.setTimeout(600_000)

    const runs: Array<[Setup, Load]> = [['off', 'steady'], ['heuristic', 'steady'], ['screen', 'steady'], ['heuristic', 'churn'], ['screen', 'churn']]
    const only = process.env.STATUS_PERF_ONLY
    for (const [setup, load] of runs) {
        if (only && !only.split(',').includes(`${setup}-${load}`)) continue
        test(`${setup} ${load}`, async () => {
            const result = await measure(setup, load)
            if (setup === 'screen' && load === 'steady') {
                expect((result.ticks as { count: number }).count).toBeGreaterThan(0)
                expect((result.shownOnScreen as { newDots: number }).newDots).toBe(working.length + asking.length)
            } else if (setup !== 'screen') {
                expect((result.ticks as { count: number }).count).toBe(0)
            }
        })
    }
})
