import { _electron as electron, ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'

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
