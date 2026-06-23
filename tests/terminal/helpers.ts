import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { LoopProject, LoopState, LoopDetectionConfig } from '../../src/shared/types'

/**
 * Shared helpers for Electron terminal pipeline tests.
 *
 * The app is launched with:
 *  - CLIMANGER_TEST_USERDATA → isolated electron-store (never touches real config)
 *  - CLIMANGER_TERM_DEBUG=1  → window.__termDebug instrumentation enabled
 *
 * Workspaces/sessions are seeded by writing config.json before launch, so no
 * native folder dialogs are needed.
 */

export const REPO_ROOT = path.resolve(__dirname, '../..')

export interface SeedSession {
    id: string
    name: string
    cwd?: string
}

export interface TermState {
    viewportY: number
    baseY: number
    length: number
    rows: number
    cols: number
    atBottom: boolean
    /** Text of the first visible row — detects content drifting under a "stable" viewport */
    topLine: string
}

export interface LaunchResult {
    app: ElectronApplication
    page: Page
    userDataDir: string
    pageErrors: string[]
    consoleErrors: string[]
}

export async function launchAppWithSessions(sessions: SeedSession[]): Promise<LaunchResult> {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-test-'))

    const config = {
        workspaces: [
            {
                id: 'test-ws',
                name: 'TestWS',
                path: REPO_ROOT,
                sessions: sessions.map(s => ({
                    id: s.id,
                    name: s.name,
                    cwd: s.cwd ?? REPO_ROOT,
                    type: 'regular'
                })),
                createdAt: 1700000000000
            }
        ],
        playgroundPath: userDataDir,
        customTemplates: [],
        settings: {
            theme: 'dark',
            fontSize: 14,
            defaultShell: 'zsh',
            defaultEditor: 'vscode',
            hasCompletedOnboarding: true,
            portFilter: { enabled: false, minPort: 3000, maxPort: 9000 },
            ignoredPorts: [],
            ignoredProcesses: [],
            portActionLogs: [],
            hooks: {
                enabled: true,
                claudeCode: {
                    enabled: true,
                    detectRunning: true,
                    detectReady: true,
                    detectError: false,
                    showInSidebar: true,
                    autoDismissSeconds: 5
                }
            }
        }
    }
    fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify(config))

    const app = await electron.launch({
        args: [path.join(REPO_ROOT, 'out/main/index.js')],
        env: {
            ...process.env,
            CLIMANGER_TEST_USERDATA: userDataDir,
            CLIMANGER_TERM_DEBUG: '1',
            // Windows stay hidden during tests (set CLIMANGER_TEST_HEADED=1 to watch)
            CLIMANGER_TEST_HEADLESS: process.env.CLIMANGER_TEST_HEADED === '1' ? '0' : '1'
        } as Record<string, string>
    })

    const page = await app.firstWindow()
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', err => pageErrors.push(String(err)))
    page.on('console', msg => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            consoleErrors.push(msg.text())
        }
    })

    await page.getByText('TestWS').first().waitFor({ timeout: 30_000 })
    await page.waitForFunction(
        (expected: number) => {
            const dbg = (window as unknown as { __termDebug?: { ids: () => string[] } }).__termDebug
            return Boolean(dbg && dbg.ids().length >= expected)
        },
        sessions.length,
        { timeout: 30_000 }
    )

    return { app, page, userDataDir, pageErrors, consoleErrors }
}

export async function closeApp(result: LaunchResult): Promise<void> {
    try {
        await result.app.close()
    } catch {
        // app may already be gone
    }
    try {
        fs.rmSync(result.userDataDir, { recursive: true, force: true })
    } catch {
        // tmp cleanup is best-effort
    }
}

/** Click a session in the sidebar to make it the active (visible) terminal. */
export async function activateSession(page: Page, name: string): Promise<void> {
    await page.getByText(name, { exact: true }).first().click()
    await page.waitForTimeout(500) // allow visibility flush + resize to settle
}

/** Send input directly to the pty (bypasses keyboard, deterministic). */
export async function writeToTerminal(page: Page, id: string, data: string): Promise<void> {
    await page.evaluate(
        ([sessionId, payload]) => {
            ;(window as unknown as { api: { writeTerminal: (id: string, d: string) => void } }).api
                .writeTerminal(sessionId, payload)
        },
        [id, data]
    )
}

export async function termState(page: Page, id: string): Promise<TermState | null> {
    return page.evaluate(
        (sessionId) =>
            (window as unknown as { __termDebug: { state: (id: string) => TermState | null } })
                .__termDebug.state(sessionId),
        id
    )
}

export async function termText(page: Page, id: string, maxLines?: number): Promise<string> {
    const text = await page.evaluate(
        ([sessionId, max]) =>
            (window as unknown as { __termDebug: { text: (id: string, m?: number) => string | null } })
                .__termDebug.text(sessionId, max as number | undefined),
        [id, maxLines] as [string, number | undefined]
    )
    return text ?? ''
}

export async function scrollTerminal(page: Page, id: string, lines: number): Promise<void> {
    await page.evaluate(
        ([sessionId, n]) =>
            (window as unknown as { __termDebug: { scrollLines: (id: string, n: number) => void } })
                .__termDebug.scrollLines(sessionId, n as number),
        [id, lines] as [string, number]
    )
}

export async function debugCounters(page: Page): Promise<{
    ptyResize: Record<string, number>
    ptyResizeTotal: number
    writeBytes: Record<string, number>
    writeErrors: number
}> {
    return page.evaluate(() =>
        (window as unknown as {
            __termDebug: { counters: () => {
                ptyResize: Record<string, number>
                ptyResizeTotal: number
                writeBytes: Record<string, number>
                writeErrors: number
            } }
        }).__termDebug.counters()
    )
}

export async function resetDebugCounters(page: Page): Promise<void> {
    await page.evaluate(() =>
        (window as unknown as { __termDebug: { resetCounters: () => void } }).__termDebug.resetCounters()
    )
}

/** Poll the buffer tail until it contains `needle` (command completion marker). */
export async function waitForBufferText(
    page: Page,
    id: string,
    needle: string,
    timeoutMs: number,
    tailLines = 80
): Promise<void> {
    const start = Date.now()
    for (;;) {
        const text = await termText(page, id, tailLines)
        if (text.includes(needle)) return
        if (Date.now() - start > timeoutMs) {
            throw new Error(`timeout waiting for "${needle}" in terminal ${id} (last tail:\n${text.slice(-800)})`)
        }
        await page.waitForTimeout(1000)
    }
}

export async function resizeMainWindow(app: ElectronApplication, width: number, height: number): Promise<void> {
    await app.evaluate(
        ({ BrowserWindow }, [w, h]) => {
            const win = BrowserWindow.getAllWindows()[0]
            if (win) win.setSize(w, h)
        },
        [width, height]
    )
}

/** Persist metrics for before/after comparison; label via METRICS_LABEL env. */
export function saveMetrics(name: string, data: unknown): void {
    const label = process.env.METRICS_LABEL || 'current'
    const dir = path.join(REPO_ROOT, 'tests/terminal/results', label)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(data, null, 2))
    // eslint-disable-next-line no-console
    console.log(`[metrics:${name}:${label}]`, JSON.stringify(data))
}

/** Extract strictly-numeric lines (seq output) and report continuity gaps. */
export function analyzeSeqContinuity(bufferText: string): {
    count: number
    first: number | null
    last: number | null
    gaps: Array<{ after: number; expected: number; got: number }>
} {
    const nums: number[] = []
    for (const line of bufferText.split('\n')) {
        const trimmed = line.trim()
        if (/^\d+$/.test(trimmed)) nums.push(Number(trimmed))
    }
    const gaps: Array<{ after: number; expected: number; got: number }> = []
    for (let i = 1; i < nums.length; i++) {
        if (nums[i] !== nums[i - 1] + 1) {
            gaps.push({ after: nums[i - 1], expected: nums[i - 1] + 1, got: nums[i] })
        }
    }
    return { count: nums.length, first: nums[0] ?? null, last: nums[nums.length - 1] ?? null, gaps }
}

// ============================================================================
// Loop Dashboard helpers (Group G-8 additions)
// ============================================================================

export interface LoopSeedProject {
    id: string
    name: string
    path: string
}

export interface LoopSeedSession {
    id: string
    loopProjectId: string
    terminalId: string
    status?: 'running' | 'ready' | 'stopped'
    loopCount?: number
}

export interface LoopLaunchOptions {
    /** Loop projects to seed into config.json */
    loopProjects: LoopSeedProject[]
    /**
     * Loop sessions to seed into config.json.
     *
     * NOTE: Due to a bug in the main process IPC handler for loop-open-terminal
     * (it receives { loopProjectId } as an object but passes it unwrapped to
     * LoopManager.openTerminal(), which expects a plain string), the
     * openLoopTerminal IPC fails silently.  Pre-seeding loopSessions in
     * config.json is the reliable workaround: LoopManager registers them on
     * startup and the LoopDashboard renderer mounts TerminalViews for them.
     */
    loopSessions?: LoopSeedSession[]
    /** Optional override for settings.loopDetection */
    loopDetection?: Partial<LoopDetectionConfig>
}

/**
 * Launch the app with one workspace (needed for app to boot) and the supplied
 * loop projects pre-seeded in config.json.  Returns the main window's Page.
 *
 * The seeded workspace id is 'test-ws'; the seeded loopProjects have
 * sourceWorkspaceId pointing to 'test-ws' by default.
 *
 * No terminal sessions are seeded, so __termDebug.ids() will initially be empty.
 * We wait only for the sidebar text "TestWS" to confirm the renderer loaded.
 */
export async function launchAppForLoop(opts: LoopLaunchOptions): Promise<LaunchResult> {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-loop-test-'))

    const seededLoopProjects = opts.loopProjects.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        sourceWorkspaceId: 'test-ws',
        createdAt: 1700000000000,
    }))

    const loopDetection: LoopDetectionConfig = {
        countMode: (opts.loopDetection?.countMode as LoopDetectionConfig['countMode']) ?? 'settle',
        debounceMs: opts.loopDetection?.debounceMs ?? 3000,
        ...(opts.loopDetection?.customPattern
            ? { customPattern: opts.loopDetection.customPattern }
            : {}),
    }

    const seededLoopSessions = (opts.loopSessions ?? []).map((s) => ({
        id: s.id,
        loopProjectId: s.loopProjectId,
        terminalId: s.terminalId,
        cliToolName: 'claude',
        status: s.status ?? 'ready',
        loopCount: s.loopCount ?? 0,
        lastLoopAt: null,
        startedAt: 1700000000000,
    }))

    const config = {
        workspaces: [
            {
                id: 'test-ws',
                name: 'TestWS',
                path: REPO_ROOT,
                sessions: [],
                createdAt: 1700000000000,
            },
        ],
        playgroundPath: userDataDir,
        customTemplates: [],
        loopProjects: seededLoopProjects,
        loopSessions: seededLoopSessions,
        settings: {
            theme: 'dark',
            fontSize: 14,
            defaultShell: 'zsh',
            defaultEditor: 'vscode',
            hasCompletedOnboarding: true,
            portFilter: { enabled: false, minPort: 3000, maxPort: 9000 },
            ignoredPorts: [],
            ignoredProcesses: [],
            portActionLogs: [],
            loopDetection,
            hooks: {
                enabled: true,
                claudeCode: {
                    enabled: true,
                    detectRunning: true,
                    detectReady: true,
                    detectError: false,
                    showInSidebar: true,
                    autoDismissSeconds: 5,
                },
            },
        },
    }
    fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify(config))

    const app = await electron.launch({
        args: [path.join(REPO_ROOT, 'out/main/index.js')],
        env: {
            ...process.env,
            CLIMANGER_TEST_USERDATA: userDataDir,
            CLIMANGER_TERM_DEBUG: '1',
            CLIMANGER_TEST_HEADLESS: process.env.CLIMANGER_TEST_HEADED === '1' ? '0' : '1',
        } as Record<string, string>,
    })

    const page = await app.firstWindow()
    const pageErrors: string[] = []
    const consoleErrors: string[] = []
    page.on('pageerror', (err) => pageErrors.push(String(err)))
    page.on('console', (msg) => {
        if (msg.type() === 'error' || msg.type() === 'warning') {
            consoleErrors.push(msg.text())
        }
    })

    // Wait for the main window sidebar to appear (no sessions seeded, so skip __termDebug check)
    await page.getByText('TestWS').first().waitFor({ timeout: 30_000 })

    return { app, page, userDataDir, pageErrors, consoleErrors }
}

/**
 * Open the Loop Dashboard window by calling window.api.openLoopWindow() on the
 * given main-window page.  Waits for and returns the new loop-window Page.
 *
 * The loop window URL contains ?mode=loop.
 */
export async function openLoopWindow(app: ElectronApplication, mainPage: Page): Promise<Page> {
    // Trigger window creation
    const newWindowPromise = app.waitForEvent('window')
    await mainPage.evaluate(() =>
        (window as unknown as { api: { openLoopWindow: () => Promise<unknown> } }).api.openLoopWindow()
    )

    const loopPage = await newWindowPromise
    await loopPage.waitForLoadState('domcontentloaded')

    // Extra wait to let the React tree mount and useLoops() to fire its initial listLoops()
    await loopPage.waitForTimeout(2000)

    return loopPage
}

/**
 * Read the current LoopState via listLoops() IPC from any window (main or loop).
 */
export async function getLoopState(page: Page): Promise<LoopState> {
    const result = await page.evaluate(async () => {
        const api = (window as unknown as { api: { listLoops: () => Promise<{ success: boolean; data?: unknown }> } }).api
        return api.listLoops()
    })
    if (!result.success || !result.data) {
        return { projects: [], sessions: [] }
    }
    return result.data as LoopState
}

/**
 * Persist a new LoopDetectionConfig via setLoopConfig() IPC.
 */
export async function setLoopConfig(page: Page, config: LoopDetectionConfig): Promise<void> {
    await page.evaluate(async (cfg) => {
        const api = (window as unknown as { api: { setLoopConfig: (c: unknown) => Promise<unknown> } }).api
        return api.setLoopConfig(cfg)
    }, config as unknown as Record<string, unknown>)
}

/**
 * Poll listLoops() until the session whose terminalId matches the supplied id
 * reports loopCount >= expected, or throw on timeout.
 *
 * @param page        - any window that has window.api (main or loop window)
 * @param terminalId  - the terminalId of the LoopSession to watch
 * @param expected    - minimum loopCount to wait for
 * @param timeoutMs   - max wait time (default 30 000 ms)
 */
export async function pollLoopCount(
    page: Page,
    terminalId: string,
    expected: number,
    timeoutMs = 30_000
): Promise<void> {
    const start = Date.now()
    let lastCount = -1

    for (;;) {
        const state = await getLoopState(page)
        const session = state.sessions.find((s) => s.terminalId === terminalId)
        lastCount = session?.loopCount ?? 0

        if (lastCount >= expected) return

        if (Date.now() - start > timeoutMs) {
            throw new Error(
                `pollLoopCount: timeout after ${timeoutMs} ms. ` +
                `Expected loopCount >= ${expected} for terminalId=${terminalId}, ` +
                `last observed: ${lastCount} (session: ${JSON.stringify(session ?? null)})`
            )
        }
        await page.waitForTimeout(1000)
    }
}
