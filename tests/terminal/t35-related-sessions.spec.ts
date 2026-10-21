import { test, expect, _electron as electron, ElectronApplication, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, LaunchResult, REPO_ROOT } from './helpers'
import type { SessionRelation } from '../../src/shared/types'

/**
 * T35 — Related sessions in the session header.
 *
 * An agent in session LEAD opens a worker and starts typing into a talk
 * session through the Control API, saying who it is with X-Caller-Session.
 * Both show up in LEAD's Related sessions dialog — with state, last line, memo
 * and the talk badge — and the user adds one by hand, goes to one, opens two
 * side by side and removes one. An agent closing a session and the user
 * deleting one each take it off the list at once. The list survives a restart.
 *
 * Judged at the ends: the header buttons and dialog in the DOM, the split view
 * slots, and config.json on disk.
 */

const LEAD = 'rs-lead-0000-4000-8000-000000000001'
const TALK = 'rs-talk-0000-4000-8000-000000000002'
const SHELL = 'rs-shell-000-4000-8000-000000000003'
const SITE = 'rs-site-0000-4000-8000-000000000004'
const LEAD_NAME = 'AI: rs1021 related sessions'
const TALK_MEMO = 'Ask about the API shape before closing'
const AGENT = `node ${path.join(REPO_ROOT, 'scripts/mock-cli/agent-mock.cjs')} --box`

interface Discovery {
    url: string
    token: string
}

test.describe('T35 related sessions', () => {
    let ctx: LaunchResult | undefined
    let relaunched: ElectronApplication | null = null
    const temps: string[] = []
    const tempDir = (prefix: string): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        temps.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (relaunched) await relaunched.close().catch(() => undefined)
        relaunched = null
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('recorded by the API, added and removed by hand, kept across a restart, gone when closed', async () => {
        // Screenshots for the review page go wherever the run asks; the test output folder otherwise.
        const shots = process.env.RELATED_SESSIONS_SHOTS ?? test.info().outputPath()
        fs.mkdirSync(shots, { recursive: true })
        const climanagerHome = tempDir('climanger-t35-home-')
        const folder = tempDir('climanger-t35-ws-')
        const env = { CLIMANAGER_HOME: climanagerHome }

        ctx = await launchAppWithWorkspaces(
            [
                {
                    id: 'ws-rs', name: 'CLImanger', path: folder, sessions: [
                        { id: LEAD, name: LEAD_NAME },
                        { id: TALK, name: '대화: 링크 다음 갈래', memo: TALK_MEMO },
                        { id: SHELL, name: 'zsh' }
                    ]
                },
                { id: 'ws-site', name: 'solhun-web-page', path: folder, sessions: [{ id: SITE, name: 'dev server' }] }
            ],
            { settings: { controlApi: { enabled: true, port: 0 } }, env }
        )
        const { page } = ctx
        await resizeMainWindow(ctx.app, 1400, 860)

        const discoveryPath = path.join(climanagerHome, 'control-api.json')
        await expect.poll(() => fs.existsSync(discoveryPath), { timeout: 15_000 }).toBe(true)
        const discovery = JSON.parse(fs.readFileSync(discoveryPath, 'utf-8')) as Discovery
        const api = async <T = unknown>(method: string, route: string, body?: unknown, caller?: string): Promise<{ status: number; json: T }> => {
            const res = await fetch(discovery.url + route, {
                method,
                headers: {
                    Authorization: `Bearer ${discovery.token}`,
                    'Content-Type': 'application/json',
                    'X-Client-Name': 't35',
                    ...(caller !== undefined ? { 'X-Caller-Session': caller } : {})
                },
                body: body === undefined ? undefined : JSON.stringify(body)
            })
            const text = await res.text()
            return { status: res.status, json: (text ? JSON.parse(text) : null) as T }
        }
        const relationsOnDisk = (userDataDir: string): SessionRelation[] =>
            JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf-8')).sessionRelations ?? []

        const button = (p: Page, id: string) => p.locator(`[data-related-button="${id}"]`)
        const dialog = (p: Page) => p.locator('[data-related-modal]')
        const row = (p: Page, id: string) => dialog(p).locator(`[data-related-row="${id}"]`)
        const inGroup = (p: Page, group: string, id: string) =>
            dialog(p).locator(`[data-related-group="${group}"] [data-related-row="${id}"]`)

        // --- Nothing related yet: the button is there anyway, to add one ------
        await activateSession(page, LEAD_NAME)
        await expect(button(page, LEAD)).toHaveAttribute('data-related-count', '0')
        await button(page, LEAD).click()
        await expect(dialog(page).locator('[data-related-empty]')).toBeVisible()
        await page.screenshot({ path: path.join(shots, 'related-modal-empty.png') })
        await page.keyboard.press('Escape')
        await expect(dialog(page)).toHaveCount(0)

        // --- The API records what LEAD's agent opens and first works in -------
        // A request that does not say who it is, or names nothing, relates nothing.
        expect((await api('GET', `/v1/sessions/${SHELL}/output`)).status).toBe(200)
        expect((await api('GET', `/v1/sessions/${SHELL}/output`, undefined, 'no-such-session')).status).toBe(200)

        const opened = await api<{ session: { id: string } }>(
            'POST',
            '/v1/sessions',
            { path: folder, name: 'worker: unit tests', command: `${AGENT} --work-ms 600000`, prompt: 'write the unit tests for related sessions' },
            LEAD
        )
        expect(opened.status, JSON.stringify(opened.json)).toBe(200)
        const worker = opened.json.session.id

        expect((await api('POST', `/v1/sessions/${TALK}/input`, { text: AGENT }, LEAD)).status).toBe(200)
        await api('POST', `/v1/sessions/${TALK}/wait`, { timeoutMs: 20_000 }, LEAD)
        expect((await api('POST', `/v1/sessions/${TALK}/input`, { text: 'ASK' }, LEAD)).status).toBe(200)

        await expect(button(page, LEAD)).toHaveAttribute('data-related-count', '2', { timeout: 10_000 })
        expect(relationsOnDisk(ctx.userDataDir).some(r => r.from === SHELL || r.to === SHELL)).toBe(false)

        // --- The dialog: groups, kinds, state, last line, memo, talk badge ----
        await button(page, LEAD).click()
        await expect(dialog(page).locator('[data-related-group="fromHere"] [data-related-row]')).toHaveCount(2)
        await expect(row(page, worker)).toHaveAttribute('data-related-kind', 'opened')
        await expect(row(page, TALK)).toHaveAttribute('data-related-kind', 'connected')
        await expect(row(page, TALK).locator('[data-talk-badge]')).toBeVisible()
        await expect(row(page, worker).locator('[data-talk-badge]')).toHaveCount(0)
        await expect(row(page, TALK).locator('[data-related-state]')).toHaveAttribute('data-related-state', 'awaiting', { timeout: 15_000 })
        await expect(row(page, worker).locator('[data-related-state]')).toHaveAttribute('data-related-state', 'busy', { timeout: 15_000 })
        await expect(row(page, TALK).locator('[data-related-memo]')).toContainText(TALK_MEMO)
        await expect(row(page, worker).locator('[data-related-last-line]')).not.toHaveText('', { timeout: 10_000 })

        // --- Added by hand ----------------------------------------------------
        await dialog(page).locator('[data-related-add-input]').fill('solhun')
        await dialog(page).locator(`[data-related-candidate="${SITE}"]`).click()
        await expect(inGroup(page, 'manual', SITE)).toBeVisible()
        await expect(button(page, LEAD)).toHaveAttribute('data-related-count', '3')
        // A prompt longer than the terminal wraps; the line reads whole, not as its last fragment.
        await expect(row(page, SITE).locator('[data-related-last-line]')).toContainText(path.basename(folder), { timeout: 10_000 })
        await page.waitForTimeout(2500) // one refresh of state and last lines after the add
        await page.screenshot({ path: path.join(shots, 'related-modal-after.png') })
        await page.keyboard.press('Escape')
        await page.screenshot({ path: path.join(shots, 'header-single-after.png') })

        const pairs = (list: SessionRelation[]) => list.filter(r => !r.dismissed).map(r => `${r.from}>${r.to}:${r.kind}`).sort()
        expect(pairs(relationsOnDisk(ctx.userDataDir))).toEqual(
            [`${LEAD}>${worker}:opened`, `${LEAD}>${TALK}:connected`, `${LEAD}>${SITE}:manual`].sort()
        )

        // --- Click one: go there the way a sidebar click does; it sees LEAD ---
        await button(page, LEAD).click()
        await row(page, worker).locator('[data-related-open]').click()
        await expect(dialog(page)).toHaveCount(0)
        await expect(button(page, worker)).toHaveAttribute('data-related-count', '1')
        await button(page, worker).click()
        await expect(inGroup(page, 'toHere', LEAD)).toBeVisible()
        await page.waitForTimeout(500)
        await page.screenshot({ path: path.join(shots, 'related-modal-opened-by.png') })
        await page.keyboard.press('Escape')

        // --- Tick two: side by side ------------------------------------------
        await activateSession(page, LEAD_NAME)
        await button(page, LEAD).click()
        await row(page, TALK).locator('[data-related-select]').check()
        await row(page, SITE).locator('[data-related-select]').check()
        await dialog(page).locator('[data-related-open-split]').click()
        await expect(page.locator(`[data-terminal-slot="${TALK}"]`)).toHaveCount(1)
        await expect(page.locator(`[data-terminal-slot="${SITE}"]`)).toHaveCount(1)
        await expect(button(page, TALK)).toHaveAttribute('data-related-count', '1')
        await expect(button(page, SITE)).toHaveAttribute('data-related-count', '1')
        await page.waitForTimeout(800)
        await page.screenshot({ path: path.join(shots, 'header-split-after.png') })

        // --- Removed by hand, and the agent's next call does not put it back --
        await button(page, TALK).click()
        await expect(inGroup(page, 'toHere', LEAD)).toBeVisible()
        await dialog(page).locator(`[data-related-remove="${LEAD}"]`).click()
        await expect(row(page, LEAD)).toHaveCount(0)
        await page.keyboard.press('Escape')
        expect((await api('GET', `/v1/sessions/${TALK}/output`, undefined, LEAD)).status).toBe(200)
        await page.waitForTimeout(500)
        await expect(button(page, TALK)).toHaveAttribute('data-related-count', '0')

        // --- An agent closes one: gone from the list and from disk ------------
        expect((await api('DELETE', `/v1/sessions/${worker}`)).status).toBe(200)
        await expect.poll(() => pairs(relationsOnDisk(ctx!.userDataDir))).toEqual([`${LEAD}>${SITE}:manual`])
        expect(relationsOnDisk(ctx.userDataDir).some(r => r.from === worker || r.to === worker)).toBe(false)
        expect(ctx.pageErrors).toEqual([])

        // --- Restart: the list comes back from disk ---------------------------
        // Not closeApp: it deletes userData, which the relaunch below reads.
        const userDataDir = ctx.userDataDir
        temps.push(userDataDir)
        await ctx.app.close()
        ctx = undefined

        relaunched = await electron.launch({
            args: [path.join(REPO_ROOT, 'out/main/index.js')],
            env: {
                ...process.env,
                CLIMANGER_TEST_USERDATA: userDataDir,
                CLIMANGER_TERM_DEBUG: '1',
                CLIMANGER_TEST_HEADLESS: '1',
                ...env
            } as Record<string, string>
        })
        const page2 = await relaunched.firstWindow()
        await page2.locator(`[data-session-item="${LEAD}"]`).waitFor({ timeout: 30_000 })
        await activateSession(page2, LEAD_NAME)
        await expect(button(page2, LEAD)).toHaveAttribute('data-related-count', '1', { timeout: 10_000 })
        await button(page2, LEAD).click()
        await expect(inGroup(page2, 'manual', SITE)).toBeVisible()
        await page2.keyboard.press('Escape')

        // --- The user deletes the other one from the sidebar: gone at once ----
        const siteRow = page2.locator(`[data-session-item="${SITE}"]`)
        await siteRow.hover()
        await siteRow.getByTitle('Delete session').click()
        await expect(siteRow).toHaveCount(0)
        await expect(button(page2, LEAD)).toHaveAttribute('data-related-count', '0')
        await expect.poll(() => pairs(relationsOnDisk(userDataDir))).toEqual([])
    })
})
