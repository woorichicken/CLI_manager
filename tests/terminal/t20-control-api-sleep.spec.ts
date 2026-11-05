import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T20 — the machine sleeps while an AI is driving a session.
 *
 * Sleep cannot be triggered from a test, but what it does to the app can:
 * every process stops running while the wall clock keeps going. SIGSTOP on the
 * app's whole process tree does exactly that, and SIGCONT is the wake-up.
 *
 * Pinned here: the session is still marked as the AI's afterwards (sidebar and
 * config.json), the API still answers, and a wait that was in flight finishes
 * with the agent's answer instead of timing out on the time that passed asleep.
 */

const AGENT_WORK_MS = 1500
const FROZEN_MS = 8_000
const TEMPLATE = {
    id: 'tpl-agent-mock',
    name: 'agent-mock',
    icon: 'terminal',
    description: 'Test agent',
    command: `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --work-ms ${AGENT_WORK_MS}`
}

interface ApiSession {
    id: string
    state: string
    controlledBy: string
}

/** The pid and every descendant: main, renderers, helpers, ptys and what runs in them. */
function processTree(root: number): number[] {
    const table = execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf-8' })
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/).map(Number) as [number, number])
    const tree = [root]
    for (let i = 0; i < tree.length; i++) {
        for (const [pid, ppid] of table) if (ppid === tree[i] && !tree.includes(pid)) tree.push(pid)
    }
    return tree
}

/**
 * Wake order: the app's main process first, then everything under it children-first. Children-first is
 * only needed inside the terminal (a shell that wakes before its stopped job takes it as Ctrl+Z); waking
 * main last left Playwright's main-process evaluate to a context that came back reset — 6/10 under load
 * on 11-05 04:10, gone with main first.
 */
function wakeOrder(frozen: number[]): number[] {
    const [main, ...rest] = frozen
    return main === undefined ? [] : [main, ...rest.reverse()]
}

function signalAll(pids: number[], signal: NodeJS.Signals): void {
    for (const pid of pids) {
        try {
            process.kill(pid, signal)
        } catch {
            // Already gone.
        }
    }
}

test.describe('T20 Control API across sleep', () => {
    let ctx: LaunchResult
    let frozen: number[] = []
    const tempDirs: string[] = []
    const tempDir = (prefix: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        tempDirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        // A failed assertion must not leave a stopped app behind.
        signalAll(wakeOrder(frozen), 'SIGCONT')
        frozen = []
        if (ctx) await closeApp(ctx)
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('an AI session is still the AI\'s after the machine sleeps and wakes', async () => {
        const climanagerHome = tempDir('climanger-t20-home-')
        const aiFolder = tempDir('climanger-t20-ai-')

        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-user', name: 'T20USER', path: tempDir('climanger-t20-user-'), sessions: [{ id: 's-t20-user', name: 'T20USERSESS' }] }],
            {
                settings: { controlApi: { enabled: true, port: 0 } },
                customTemplates: [TEMPLATE],
                env: { CLIMANAGER_HOME: climanagerHome }
            }
        )
        const { page, userDataDir, app } = ctx
        // 2026-11-05 this test failed 3/3 for ~18 minutes with "Execution context was destroyed" and
        // "other side closed" right after the wake-up, then passed on the same build. Keep what main
        // said and whether it was still alive, so the next occurrence can be read instead of guessed.
        const mainProc = app.process()
        const mainOutput: string[] = []
        const keep = (chunk: Buffer | string): void => {
            mainOutput.push(String(chunk))
            if (mainOutput.length > 200) mainOutput.shift()
        }
        mainProc.stdout?.on('data', keep)
        mainProc.stderr?.on('data', keep)
        let mainExit = 'still running'
        mainProc.on('exit', (code, signal) => (mainExit = `exited code=${code} signal=${signal}`))
        const describeMain = (): string => {
            let alive = false
            try {
                process.kill(mainProc.pid!, 0)
                alive = true
            } catch {
                // Gone.
            }
            return `[t20] main pid=${mainProc.pid} alive=${alive} ${mainExit}\n[t20] main output tail:\n${mainOutput.join('').split('\n').slice(-40).join('\n')}`
        }

        const discoveryPath = path.join(climanagerHome, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as { url: string; token: string }

        const api = async <T = unknown>(method: string, route: string, body?: unknown): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    'X-Client-Name': 't20'
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }

        const opened = await api<{ session: ApiSession; promptSent: boolean; note?: string }>(
            'POST', '/v1/sessions',
            { path: aiFolder, template: 'agent-mock', name: 'T20AISESS', prompt: 'before sleep' }
        )
        expect(opened.json.promptSent, opened.json.note).toBe(true)
        const sessionId = opened.json.session.id
        const aiRow = page.locator(`[data-session-item="${sessionId}"]`)
        await expect(aiRow).toHaveClass(/emerald/, { timeout: 15_000 })
        const settled = await api<{ lines: string[] }>('POST', `/v1/sessions/${sessionId}/wait`, { timeoutMs: 30_000 })
        expect(settled.json.lines.join('\n')).toContain('ANSWER[1]: before sleep')

        // --- Sleep with a wait in flight -----------------------------------
        // The wait's budget is shorter than the sleep: if time asleep counted
        // against it, it would come back timed out the moment the app wakes.
        await api('POST', `/v1/sessions/${sessionId}/input`, { text: 'during sleep' })
        const inFlight = api<{ lines: string[]; timedOut: boolean; waitedMs: number }>(
            'POST', `/v1/sessions/${sessionId}/wait`, { timeoutMs: FROZEN_MS - 3_000 }
        )
        await new Promise((resolve) => setTimeout(resolve, 300))

        const mainPid = app.process().pid!
        frozen = processTree(mainPid)
        expect(frozen.length).toBeGreaterThan(2)
        signalAll(frozen, 'SIGSTOP')
        const frozenAt = Date.now()
        await new Promise((resolve) => setTimeout(resolve, FROZEN_MS))
        // Children first. A shell that wakes before its stopped job reads it as Ctrl+Z — "zsh: suspended
        // (signal)" — takes the terminal back, and the agent never answers (the wait times out). A real
        // sleep stops nothing, so that race is this simulation's, not the app's. (Stopping goes parents
        // first, so no shell is awake to see its job stop.)
        signalAll(wakeOrder(frozen), 'SIGCONT')
        frozen = []
        // What Electron reports on a real wake-up, for anything listening to it.
        let woke: Awaited<typeof inFlight>
        try {
            await app.evaluate(({ powerMonitor }) => {
                powerMonitor.emit('suspend')
                powerMonitor.emit('resume')
            })
            woke = await inFlight
        } catch (error) {
            const flight = await inFlight.then(
                (r) => `answered status=${r.status} timedOut=${r.json?.timedOut}`,
                (e: Error & { cause?: unknown }) => `failed: ${e.message} (${String(e.cause)})`
            )
            console.log(`${describeMain()}\n[t20] in-flight wait: ${flight}`)
            throw error
        }
        console.log(`[t20] in-flight wait: status=${woke.status} timedOut=${woke.json.timedOut} waitedMs=${woke.json.waitedMs} frozenMs=${Date.now() - frozenAt}`)
        expect(woke.status).toBe(200)
        if (woke.json.timedOut) console.log(`${describeMain()}\n[t20] screen when the wait gave up:\n${woke.json.lines.slice(-15).join('\n')}`)
        expect(woke.json.timedOut).toBe(false)
        expect(woke.json.lines.join('\n')).toContain('ANSWER[2]: during sleep')

        // --- Still the AI's session ----------------------------------------
        await expect(aiRow).toHaveClass(/emerald/)
        const stored = JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8'))
        const storedSession = stored.workspaces
            .flatMap((w: { sessions: Array<{ id: string; aiControl?: { client: string } }> }) => w.sessions)
            .find((s: { id: string }) => s.id === sessionId)
        expect(storedSession?.aiControl?.client).toBe('t20')

        const listed = await api<ApiSession[]>('GET', '/v1/sessions')
        expect(listed.json.map((s) => s.id)).toContain(sessionId)

        // --- And still drivable --------------------------------------------
        await api('POST', `/v1/sessions/${sessionId}/input`, { text: 'after sleep' })
        const after = await api<{ lines: string[]; timedOut: boolean }>('POST', `/v1/sessions/${sessionId}/wait`, { timeoutMs: 30_000 })
        expect(after.json.timedOut).toBe(false)
        expect(after.json.lines.join('\n')).toContain('ANSWER[3]: after sleep')

        expect(ctx.pageErrors).toEqual([])
    })
})
