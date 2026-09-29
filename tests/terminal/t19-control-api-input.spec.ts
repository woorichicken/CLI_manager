import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult, REPO_ROOT } from './helpers'

/**
 * T19 — Control API defects found while driving real agents (2026-09-28/29).
 *
 * Each case reproduces the failure with agent-mock options rather than a real
 * CLI, and checks the outcome where it lands: what the program printed
 * (ANSWER[n]), what `read` returned, and the discovery file on disk.
 *
 *   1. Another instance quitting deleted the running app's discovery file.
 *   2. Codex's folder-trust dialog was not recognised as a question.
 *   3. Under load, Enter did not submit and the prompt sat in the input box.
 *   4. Text sent right after an Escape key was read as Alt+char and lost.
 *   5. The dim next-prompt suggestion read like something a person typed.
 */

const MOCK = `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --work-ms 800`
const template = (id: string, flags: string) => ({ id, name: id, icon: 'terminal', description: 'Test agent', command: `${MOCK} ${flags}` })
const TEMPLATES = [
    template('mock-plain', ''),
    template('mock-box', '--box'),
    template('mock-box-drop', '--box --drop-enters 1'),
    template('mock-codex-trust', '--codex-trust')
]

interface ApiSession {
    id: string
    awaitingInput: boolean
}
interface ApiOutput {
    session: ApiSession
    lines: string[]
    suggestion: string | null
}
interface OpenResult {
    session: ApiSession
    promptSent: boolean
    note?: string
}
interface Discovery {
    url: string
    token: string
    pid: number
}

test.describe('T19 Control API input and discovery', () => {
    let ctx: LaunchResult | undefined
    const tempDirs: string[] = []
    const tempDir = (prefix: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        tempDirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    const launch = async (climanagerHome: string): Promise<{ discoveryPath: string; discovery: Discovery }> => {
        ctx = await launchAppWithWorkspaces(
            [{ id: 'ws-user', name: 'T19USER', path: tempDir('climanger-t19-user-'), sessions: [{ id: 's-user', name: 'T19USERSESS' }] }],
            {
                settings: { controlApi: { enabled: true, port: 0 } },
                customTemplates: TEMPLATES,
                env: { CLIMANAGER_HOME: climanagerHome }
            }
        )
        const discoveryPath = path.join(climanagerHome, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        return { discoveryPath, discovery: JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery }
    }

    test('1. quitting removes only the discovery file this instance wrote', async () => {
        // Own file: removed on quit, so tools do not try a server that is gone.
        const ownHome = tempDir('climanger-t19-own-')
        const own = await launch(ownHome)
        await closeApp(ctx!)
        ctx = undefined
        expect(fs.existsSync(own.discoveryPath)).toBe(false)

        // Another instance's file (a different pid): left alone on quit.
        const sharedHome = tempDir('climanger-t19-shared-')
        const shared = await launch(sharedHome)
        const foreign = { ...shared.discovery, pid: shared.discovery.pid + 100_000 }
        fs.writeFileSync(shared.discoveryPath, JSON.stringify(foreign))
        await closeApp(ctx!)
        ctx = undefined
        expect(fs.existsSync(shared.discoveryPath)).toBe(true)
        expect(JSON.parse(fs.readFileSync(shared.discoveryPath, 'utf-8')).pid).toBe(foreign.pid)
    })

    /** Launches the app and returns API helpers bound to it. */
    const connect = async () => {
        const { discovery } = await launch(tempDir('climanger-t19-home-'))
        const api = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: { Authorization: `Bearer ${discovery.token}`, 'Content-Type': 'application/json', 'X-Client-Name': 't19' },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            expect(res.status, text).toBe(200)
            return JSON.parse(text) as T
        }
        return {
            api,
            open: (template: string, prompt?: string): Promise<OpenResult> =>
                api<OpenResult>('POST', '/v1/sessions', { path: tempDir('climanger-t19-ai-'), template, ...(prompt ? { prompt } : {}) }),
            wait: (id: string): Promise<ApiOutput> => api<ApiOutput>('POST', `/v1/sessions/${id}/wait`, { timeoutMs: 30_000 })
        }
    }
    const screenOf = (output: ApiOutput): string => output.lines.join('\n')

    test("2. Codex's folder-trust dialog holds the first prompt back", async () => {
        const { api, open, wait } = await connect()
        const codex = await open('mock-codex-trust', 'first task')
        expect(codex.promptSent, codex.note).toBe(false)
        expect(codex.session.awaitingInput).toBe(true)
        await api('POST', `/v1/sessions/${codex.session.id}/input`, { keys: ['enter'] })
        expect(screenOf(await wait(codex.session.id))).toContain('TRUSTED')
        await api('POST', `/v1/sessions/${codex.session.id}/input`, { text: 'first task' })
        expect(screenOf(await wait(codex.session.id))).toContain('ANSWER[1]: first task')
    })

    test('3. an Enter the program dropped is pressed again, and only when needed', async () => {
        const { open, wait } = await connect()
        const dropped = await open('mock-box-drop', 'dropped enter prompt')
        expect(dropped.promptSent, dropped.note).toBe(true)
        const droppedScreen = screenOf(await wait(dropped.session.id))
        expect(droppedScreen).toContain('ANSWER[1]: dropped enter prompt')
        expect(droppedScreen).not.toContain('ANSWER[2]')

        // A box that submits on the first Enter gets no extra one.
        const boxed = await open('mock-box', 'boxed prompt')
        expect(boxed.promptSent, boxed.note).toBe(true)
        const boxedScreen = screenOf(await wait(boxed.session.id))
        expect(boxedScreen).toContain('ANSWER[1]: boxed prompt')
        expect(boxedScreen).not.toContain('ANSWER[2]')
    })

    test('4. text sent right after Escape arrives whole', async () => {
        const { api, open, wait } = await connect()
        const plain = await open('mock-plain')
        await wait(plain.session.id)
        await api('POST', `/v1/sessions/${plain.session.id}/input`, { keys: ['escape'] })
        await api('POST', `/v1/sessions/${plain.session.id}/input`, { text: 'after escape' })
        expect(screenOf(await wait(plain.session.id))).toContain('ANSWER[1]: after escape')
    })

    test('5. the dim next-prompt suggestion is reported apart from typed text', async () => {
        const { api, open, wait } = await connect()
        const boxed = await open('mock-box', 'boxed prompt')
        const answered = await wait(boxed.session.id)
        expect(screenOf(answered)).toContain('ANSWER[1]: boxed prompt')
        expect(answered.suggestion).toBe('run the tests next')

        await api('POST', `/v1/sessions/${boxed.session.id}/input`, { text: 'typed by the api', submit: false })
        const typed = await api<ApiOutput>('GET', `/v1/sessions/${boxed.session.id}/output`)
        expect(screenOf(typed)).toContain('typed by the api')
        expect(typed.suggestion).toBeNull()
    })
})
