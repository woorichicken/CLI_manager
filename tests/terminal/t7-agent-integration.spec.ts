import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { REPO_ROOT, waitForBufferText } from './helpers'
import type { AgentStatusUpdate, UsageSnapshot, IPCResult, DiffSummary, FileDiff, SessionStatus, AgentStatusSource } from '../../src/shared/types'

/**
 * The preload bridge as seen from inside page.evaluate. Declared here because
 * the renderer's ambient window typing is not part of the test tsconfig.
 */
interface TestApi {
    getAgentStatusSnapshot: () => Promise<AgentStatusUpdate[]>
    reportObservedStatus: (terminalId: string, status: SessionStatus, source: AgentStatusSource) => void
    getUsageSnapshot: () => Promise<UsageSnapshot>
    getDiffSummary: (workspaceId: string, base: 'head' | 'base-branch') => Promise<IPCResult<DiffSummary>>
    getFileDiff: (workspaceId: string, filePath: string, base: 'head' | 'base-branch') => Promise<IPCResult<FileDiff>>
    sendTextToTerminal: (terminalId: string, text: string) => Promise<IPCResult<null>>
}

/**
 * Reaches the preload bridge from inside page.evaluate.
 *
 * Written as an inline assertion rather than a helper function because evaluate
 * bodies are serialized into the page and cannot close over Node-side scope —
 * the assertion is erased at compile time, leaving plain `window.api`.
 */
type BridgeWindow = Window & { api: TestApi }

/**
 * T7 — Official agent integration: hook events, usage, and diff review.
 *
 * These exercise the real Electron app rather than the modules in isolation, so
 * they cover the wiring (spool watcher -> resolver -> IPC -> renderer) that unit
 * tests cannot reach.
 *
 * Isolation:
 *   CLIMANAGER_HOME  redirects the hook spool to a temp dir
 *   CODEX_HOME       redirects Codex session discovery to a temp dir
 *   CLIMANGER_TEST_USERDATA / _HEADLESS  as in the other suites
 * The user's real ~/.claude, ~/.codex and ~/.climanager are never touched —
 * hookIntegrationAllowed() also refuses to install while these are set.
 */

/**
 * Polls `read` until it returns a non-null value.
 *
 * Used instead of page.waitForFunction because that returns a JSHandle, and
 * handles produced by an async predicate did not serialize reliably here —
 * evaluating to a plain value each tick keeps the assertion honest.
 */
async function pollFor<T>(page: Page, read: () => Promise<T | null>, timeoutMs = 20_000): Promise<T> {
    const start = Date.now()
    for (;;) {
        const value = await read()
        if (value !== null && value !== undefined) return value
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for value')
        await page.waitForTimeout(250)
    }
}

interface Ctx {
    app: ElectronApplication
    page: Page
    spoolDir: string
    repoDir: string
    codexHome: string
}

/** Writes one spool file exactly the way the installed hook script does. */
function writeSpoolEvent(spoolDir: string, source: string, payload: unknown): void {
    fs.mkdirSync(spoolDir, { recursive: true })
    const file = path.join(spoolDir, `ev-${Math.random().toString(36).slice(2, 10)}`)
    fs.writeFileSync(file, JSON.stringify({ climanager: { source }, payload }))
}

/** Builds a throwaway git repo with a committed base and uncommitted edits. */
function makeGitRepo(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-diffrepo-'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })

    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])

    fs.writeFileSync(path.join(dir, 'existing.ts'), 'export const a = 1\nexport const b = 2\nexport const c = 3\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'base'])

    // Modify a tracked file and add an untracked one — agents produce both, and
    // plain `git diff` only reports the first.
    fs.writeFileSync(path.join(dir, 'existing.ts'), 'export const a = 1\nexport const b = 99\nexport const c = 3\n')
    fs.writeFileSync(path.join(dir, 'brand-new.ts'), 'export const created = true\n')

    return dir
}

/** Writes a Codex rollout file whose rate_limits mirror the real format. */
function seedCodexRollout(codexHome: string, usedPercent: number, resetsAt: number): void {
    const dir = path.join(codexHome, 'sessions', '2026', '08', '15')
    fs.mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({
        type: 'token_count',
        info: {
            rate_limits: {
                limit_id: 'codex',
                primary: { used_percent: usedPercent, window_minutes: 10080, resets_at: resetsAt },
                secondary: null,
                plan_type: 'pro'
            }
        }
    })
    fs.writeFileSync(path.join(dir, 'rollout-2026-08-15T00-00-00-test.jsonl'), line + '\n')
}

async function launch(options: { workspacePath: string; sessionCwd: string }): Promise<Ctx> {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t7-'))
    const climanagerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-home-'))
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-codex-'))

    const config = {
        workspaces: [
            {
                id: 'test-ws',
                name: 'TestWS',
                path: options.workspacePath,
                sessions: [
                    {
                        id: 'sess-a',
                        name: 'agent-a',
                        cwd: options.sessionCwd,
                        type: 'regular',
                        // Mirrors what CLISessionTracker records when it injects
                        // --session-id; this is the key hook events match on.
                        cliSessionId: 'claude-sess-aaa',
                        cliToolName: 'claude'
                    }
                ],
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
            notifications: { enabled: false, tools: { cc: true, codex: true, gemini: true, generic: true } },
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
            },
            usageAlerts: { enabled: true, claudeThresholdPercent: 80, codexThresholdPercent: 40 }
        }
    }
    fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify(config))

    seedCodexRollout(codexHome, 45, Math.floor(Date.now() / 1000) + 86_400)

    const app = await electron.launch({
        args: [path.join(REPO_ROOT, 'out/main/index.js')],
        env: {
            ...process.env,
            CLIMANGER_TEST_USERDATA: userDataDir,
            CLIMANAGER_HOME: climanagerHome,
            CODEX_HOME: codexHome,
            CLIMANGER_TERM_DEBUG: '1',
            CLIMANGER_TEST_HEADLESS: process.env.CLIMANGER_TEST_HEADED === '1' ? '0' : '1'
        } as Record<string, string>
    })

    const page = await app.firstWindow()
    await page.getByText('TestWS').first().waitFor({ timeout: 30_000 })

    return { app, page, spoolDir: path.join(climanagerHome, 'events'), repoDir: options.workspacePath, codexHome }
}

async function close(ctx: Ctx): Promise<void> {
    try {
        await ctx.app.close()
    } catch {
        // Already gone.
    }
}

test.describe('T7 agent integration', () => {
    test('hook events drive session status and outrank the heuristic', async () => {
        const ctx = await launch({ workspacePath: REPO_ROOT, sessionCwd: REPO_ROOT })

        try {
            // A turn starts: the session must report running, sourced from the hook.
            writeSpoolEvent(ctx.spoolDir, 'claude-hook', {
                hook_event_name: 'UserPromptSubmit',
                session_id: 'claude-sess-aaa',
                cwd: REPO_ROOT
            })

            const running = await pollFor(ctx.page, () =>
                ctx.page.evaluate(async () => {
                    const snapshot = await (window as unknown as BridgeWindow).api.getAgentStatusSnapshot()
                    const entry = snapshot.find((s) => s.terminalId === 'sess-a')
                    return entry?.status === 'running' && entry.source === 'hook' ? entry : null
                })
            )
            expect(running).toMatchObject({ status: 'running', source: 'hook' })

            // A permission prompt must be distinguishable from "finished", because
            // that is the state the user actually has to act on.
            writeSpoolEvent(ctx.spoolDir, 'claude-hook', {
                hook_event_name: 'PermissionRequest',
                session_id: 'claude-sess-aaa',
                cwd: REPO_ROOT,
                tool_name: 'Bash'
            })

            const awaiting = await pollFor(ctx.page, () =>
                ctx.page.evaluate(async () => {
                    const snapshot = await (window as unknown as BridgeWindow).api.getAgentStatusSnapshot()
                    const entry = snapshot.find((s) => s.terminalId === 'sess-a')
                    return entry?.awaitingInput ? entry : null
                })
            )
            expect(awaiting).toMatchObject({ awaitingInput: true, detail: 'Bash', source: 'hook' })

            // The legacy heuristic must not be able to overwrite a fresh hook
            // status — this is what makes the migration non-destructive.
            await ctx.page.evaluate(() => (window as unknown as BridgeWindow).api.reportObservedStatus('sess-a', 'running', 'heuristic'))
            await ctx.page.waitForTimeout(500)

            const afterHeuristic = await ctx.page.evaluate(async () => {
                const snapshot = await (window as unknown as BridgeWindow).api.getAgentStatusSnapshot()
                return snapshot.find((s) => s.terminalId === 'sess-a')
            })
            expect(afterHeuristic).toMatchObject({ source: 'hook', awaitingInput: true })

            // A session with no hook history still accepts the heuristic, so
            // unhooked terminals behave exactly as before.
            await ctx.page.evaluate(() => (window as unknown as BridgeWindow).api.reportObservedStatus('sess-unhooked', 'running', 'heuristic'))
            const fallback = await pollFor(ctx.page, () =>
                ctx.page.evaluate(async () => {
                    const snapshot = await (window as unknown as BridgeWindow).api.getAgentStatusSnapshot()
                    return snapshot.find((s) => s.terminalId === 'sess-unhooked') ?? null
                })
            )
            expect(fallback).toMatchObject({ status: 'running', source: 'heuristic' })
        } finally {
            await close(ctx)
        }
    })

    test('usage is read from provider-reported limits, not estimated', async () => {
        const ctx = await launch({ workspacePath: REPO_ROOT, sessionCwd: REPO_ROOT })

        try {
            // Codex: parsed from the seeded rollout file on the weekly window.
            const codex = await pollFor(
                ctx.page,
                () =>
                    ctx.page.evaluate(async () => {
                        const snapshot = await (window as unknown as BridgeWindow).api.getUsageSnapshot()
                        return snapshot.codex?.weekly ? snapshot.codex : null
                    }),
                30_000
            )
            expect(codex).toMatchObject({
                weekly: { usedPercent: 45, windowMinutes: 10080, label: '7d' },
                planType: 'pro'
            })

            // Claude: arrives through the statusLine payload, the only place the
            // official rate_limits are exposed.
            writeSpoolEvent(ctx.spoolDir, 'claude-statusline', {
                session_id: 'claude-sess-aaa',
                context_window: { used_percentage: 62 },
                rate_limits: {
                    five_hour: { used_percentage: 23.5, resets_at: 1_800_000_000 },
                    seven_day: { used_percentage: 41.2, resets_at: 1_800_100_000 }
                }
            })

            const claude = await pollFor(ctx.page, () =>
                ctx.page.evaluate(async () => {
                    const snapshot = await (window as unknown as BridgeWindow).api.getUsageSnapshot()
                    return snapshot.claude?.fiveHour ? snapshot.claude : null
                })
            )
            expect(claude).toMatchObject({
                fiveHour: { usedPercent: 23.5, label: '5h' },
                sevenDay: { usedPercent: 41.2, label: '7d' },
                contextPercent: 62
            })
        } finally {
            await close(ctx)
        }
    })

    test('diff summary includes untracked files and resolves hunks', async () => {
        const repo = makeGitRepo()
        const ctx = await launch({ workspacePath: repo, sessionCwd: repo })

        try {
            const summary = await ctx.page.evaluate(() => (window as unknown as BridgeWindow).api.getDiffSummary('test-ws', 'head'))
            expect(summary.success).toBe(true)

            const paths = summary.data!.files.map((f) => f.path).sort()
            // The untracked file is the one a naive `git diff` would silently drop.
            expect(paths).toEqual(['brand-new.ts', 'existing.ts'])
            expect(summary.data!.files.find((f) => f.path === 'brand-new.ts')!.status).toBe('added')
            expect(summary.data!.files.find((f) => f.path === 'existing.ts')!.status).toBe('modified')

            const fileDiff = await ctx.page.evaluate(() =>
                (window as unknown as BridgeWindow).api.getFileDiff('test-ws', 'existing.ts', 'head')
            )
            expect(fileDiff.success).toBe(true)
            expect(fileDiff.data!.hunks.length).toBeGreaterThan(0)

            const lines = fileDiff.data!.hunks.flatMap((h) => h.lines)
            const added = lines.find((l) => l.type === 'add')
            const deleted = lines.find((l) => l.type === 'del')

            expect(added?.content).toContain('b = 99')
            expect(deleted?.content).toContain('b = 2')
            // Line numbers are what a review comment cites, so they must be real.
            expect(added?.newNumber).toBe(2)
            expect(deleted?.oldNumber).toBe(2)

            // An untracked file must produce a readable diff too, not an error.
            const newFileDiff = await ctx.page.evaluate(() =>
                (window as unknown as BridgeWindow).api.getFileDiff('test-ws', 'brand-new.ts', 'head')
            )
            expect(newFileDiff.success).toBe(true)
            expect(newFileDiff.data!.hunks.flatMap((h) => h.lines).some((l) => l.content.includes('created'))).toBe(true)
        } finally {
            await close(ctx)
            fs.rmSync(repo, { recursive: true, force: true })
        }
    })

    test('review comment reaches the agent terminal with file and line', async () => {
        const repo = makeGitRepo()
        const ctx = await launch({ workspacePath: repo, sessionCwd: repo })

        try {
            // Wait for the pty to exist before writing into it.
            await ctx.page.waitForFunction(
                () => {
                    const dbg = (window as unknown as { __termDebug?: { ids: () => string[] } }).__termDebug
                    return Boolean(dbg && dbg.ids().includes('sess-a'))
                },
                undefined,
                { timeout: 30_000 }
            )

            const marker = `REVIEW-${Date.now()}`
            const sent = await ctx.page.evaluate(
                ({ text }) => (window as unknown as BridgeWindow).api.sendTextToTerminal('sess-a', text),
                { text: `# existing.ts:2 ${marker}` }
            )
            expect(sent.success).toBe(true)

            // The prompt must land in the terminal the reviewer targeted, and it
            // must NOT be submitted for them — no trailing newline is sent.
            await waitForBufferText(ctx.page, 'sess-a', marker, 20_000)
            const text = await ctx.page.evaluate(() => {
                const dbg = (window as unknown as { __termDebug?: { text: (id: string) => string } }).__termDebug
                return dbg?.text('sess-a') ?? ''
            })
            expect(text).toContain('existing.ts:2')
        } finally {
            await close(ctx)
            fs.rmSync(repo, { recursive: true, force: true })
        }
    })
})
