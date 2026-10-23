import { test, expect, Page } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, activateSession, resizeMainWindow, LaunchResult, termText } from './helpers'
import type { SessionRelation, Workspace } from '../../src/shared/types'

/**
 * T50 — day-1023 feedback on the Related dialog and the session header.
 *
 * - 9f4f923e: a Claude-style screen shows its recap whole in the dialog, or no line at all.
 * - 49825c14: the Relations tab's order can be chosen, and is remembered.
 * - b9b8d393: a session can be started from the dialog (project + template) and is listed there.
 * - 1ae4d3c8: the header has a shortcut to the session that opened this one, when there is one.
 * - 38121cd5: ‹ › in the header go back and forward through the sessions shown.
 *
 * The "Claude" sessions are a shell script that draws a transcript tail and an
 * input box, then waits. Judged in the DOM, config.json and the terminal buffer.
 */

const CHIEF = 't50-chief-0-4000-8000-000000000001'
const LEAD = 't50-lead-00-4000-8000-000000000002'
const RECAP = 't50-recap-0-4000-8000-000000000003'
const NO_RECAP = 't50-norec-0-4000-8000-000000000004'
const ZULU = 't50-zulu-00-4000-8000-000000000005'
const ALPHA = 't50-alpha-0-4000-8000-000000000006'
const OTHER = 't50-other-0-4000-8000-000000000007'

const NAMES: Record<string, string> = {
    [CHIEF]: 'AI: t50 chief',
    [LEAD]: 'AI: t50 lead',
    [RECAP]: 'AI: t50 recap',
    [NO_RECAP]: 'AI: t50 no recap',
    [ZULU]: 'AI: t50 zulu',
    [ALPHA]: 'AI: t50 alpha',
    [OTHER]: 'other shell'
}

const RELATIONS: SessionRelation[] = [
    { from: CHIEF, to: LEAD, kind: 'opened', at: 1 },
    { from: LEAD, to: RECAP, kind: 'opened', at: 2 },
    { from: LEAD, to: NO_RECAP, kind: 'opened', at: 3 },
    { from: LEAD, to: ZULU, kind: 'opened', at: 4 },
    { from: LEAD, to: ALPHA, kind: 'opened', at: 5 },
    // ALPHA has two parents: the header shortcut stays away.
    { from: CHIEF, to: ALPHA, kind: 'connected', at: 6 }
]

const RULE = '─'.repeat(40)
const RECAP_TEXT = 'T50 요약 첫 줄입니다, 둘째 줄로 이어집니다.'
const TEMPLATE = { id: 't50-echo', name: 'T50 echo', icon: 'terminal', description: 'prints a marker', command: 'echo T50-TEMPLATE-RAN' }

function fakeClaude(dir: string, file: string, withRecap: boolean): string {
    const recap = withRecap
        ? "※ recap: T50 요약 첫 줄입니다,\\n  둘째 줄로 이어집니다. (disable recaps in /config)\\n\\n"
        : ''
    const script = path.join(dir, file)
    fs.writeFileSync(script, [
        '#!/bin/sh',
        `printf '⏺ 결과를 정리했습니다.\\n\\n✻ Brewed for 1m 24s · done 9:43 PM\\n\\n${recap}%s\\n❯ \\n%s\\n  ? for shortcuts\\n' '${RULE}' '${RULE}'`,
        'exec cat',
        ''
    ].join('\n'))
    return script
}

test.describe('T50 related dialog and header (day-1023)', () => {
    let ctx: LaunchResult | undefined
    const temps: string[] = []

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        ctx = undefined
        for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
    })

    async function launch(): Promise<LaunchResult> {
        const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t50-ws-'))
        const other = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t50-other-'))
        const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t50-home-'))
        temps.push(folder, other, homeDir)
        const withRecap = fakeClaude(folder, 'with-recap.sh', true)
        const withoutRecap = fakeClaude(folder, 'without-recap.sh', false)
        const session = (id: string, extra: Record<string, string> = {}) => ({ id, name: NAMES[id], ...extra })
        return launchAppWithWorkspaces(
            [
                {
                    id: 'ws-t50', name: 'T50 project', path: folder, sessions: [
                        session(CHIEF), session(LEAD),
                        session(RECAP, { initialCommand: `sh ${withRecap}` }),
                        session(NO_RECAP, { initialCommand: `sh ${withoutRecap}` }),
                        session(ZULU), session(ALPHA)
                    ]
                },
                { id: 'ws-t50-other', name: 'T50 other project', path: other, sessions: [session(OTHER)] }
            ],
            { config: { sessionRelations: RELATIONS }, env: { CLIMANAGER_HOME: homeDir }, customTemplates: [TEMPLATE] }
        )
    }

    const button = (p: Page, id: string) => p.locator(`[data-related-button="${id}"]`)
    const dialog = (p: Page) => p.locator('[data-related-modal]')
    const downRows = (p: Page) => dialog(p).locator('[data-related-tree="down"] [data-related-row]')
    const shotsDir = (): string | undefined => {
        const shots = process.env.RELATED_SESSIONS_SHOTS
        if (shots) fs.mkdirSync(shots, { recursive: true })
        return shots
    }
    const configOnDisk = (userDataDir: string) =>
        JSON.parse(fs.readFileSync(path.join(userDataDir, 'config.json'), 'utf8')) as { workspaces: Workspace[]; sessionRelations?: SessionRelation[] }

    test('T50 recap line, order choice', async () => {
        ctx = await launch()
        const { page } = ctx
        const shots = shotsDir()

        // Both fake agents must have drawn their screen before the dialog polls them.
        for (const id of [RECAP, NO_RECAP]) {
            await activateSession(page, NAMES[id])
            await expect.poll(() => termText(page, id), { timeout: 15_000 }).toContain('for shortcuts')
        }

        await activateSession(page, NAMES[LEAD])
        await button(page, LEAD).click()

        // 9f4f923e — the recap whole, without its hint; nothing for a screen without one.
        const recapLine = dialog(page).locator(`[data-related-last-line="${RECAP}"]`)
        await expect(recapLine).toHaveText(RECAP_TEXT, { timeout: 10_000 })
        await expect(recapLine).toHaveAttribute('data-related-recap', 'true')
        await page.waitForTimeout(2500) // one more poll: the no-recap row stays empty
        await expect(dialog(page).locator(`[data-related-last-line="${NO_RECAP}"]`)).toHaveCount(0)

        // 49825c14 — order within the level: newest first by default, then by name, then oldest first.
        const order = dialog(page).locator('[data-related-order]')
        await expect(order).toHaveValue('newest')
        await expect(downRows(page)).toHaveCount(4)
        const ids = async () => downRows(page).evaluateAll(rows => rows.map(row => row.getAttribute('data-related-row')))
        expect(await ids()).toEqual([ALPHA, ZULU, NO_RECAP, RECAP])
        await order.selectOption('name')
        expect(await ids()).toEqual([ALPHA, NO_RECAP, RECAP, ZULU])
        if (shots) await page.screenshot({ path: path.join(shots, 'related-recap-sort-1280.png') })
        await order.selectOption('oldest')
        expect(await ids()).toEqual([RECAP, NO_RECAP, ZULU, ALPHA])

        // Remembered: the next dialog opens with the same order.
        await page.keyboard.press('Escape')
        await expect(dialog(page)).toHaveCount(0)
        await button(page, LEAD).click()
        await expect(dialog(page).locator('[data-related-order]')).toHaveValue('oldest')
        expect(await ids()).toEqual([RECAP, NO_RECAP, ZULU, ALPHA])
    })

    test('T50 parent shortcut and back/forward', async () => {
        ctx = await launch()
        const { page } = ctx
        const shots = shotsDir()
        const parent = page.locator('[data-parent-session]')
        const back = page.locator('[data-session-back]')
        const forward = page.locator('[data-session-forward]')

        // 1ae4d3c8 — one parent: a shortcut to it. None, or two: no shortcut.
        await activateSession(page, NAMES[LEAD])
        await expect(parent).toHaveAttribute('data-parent-session', CHIEF)
        await expect(parent).toContainText(NAMES[CHIEF])
        if (shots) await page.screenshot({ path: path.join(shots, 'header-parent-history-1280.png') })
        await parent.click()
        await expect(button(page, CHIEF)).toBeVisible()
        await expect(button(page, LEAD)).not.toBeVisible()
        await expect(parent).toHaveCount(0)
        await activateSession(page, NAMES[ALPHA])
        await expect(parent).toHaveCount(0)

        // 38121cd5 — history so far: LEAD → CHIEF (shortcut) → ALPHA.
        await expect(forward).toBeDisabled()
        await back.click()
        await expect(button(page, CHIEF)).toBeVisible()
        await back.click()
        await expect(button(page, LEAD)).toBeVisible()
        await expect(forward).toBeEnabled()
        await forward.click()
        await expect(button(page, CHIEF)).toBeVisible()

        // Any other switch starts a new branch: forward is gone.
        await activateSession(page, NAMES[ZULU])
        await expect(button(page, ZULU)).toBeVisible()
        await expect(forward).toBeDisabled()
        await back.click()
        await expect(button(page, CHIEF)).toBeVisible()
    })

    test('T50 new session from the dialog', async () => {
        ctx = await launch()
        const { page } = ctx
        const shots = shotsDir()

        await activateSession(page, NAMES[LEAD])
        await button(page, LEAD).click()
        await dialog(page).locator('[data-related-new]').click()
        const form = dialog(page).locator('[data-related-new-form]')
        await expect(form).toBeVisible()
        await expect(form.locator('[data-related-new-workspace]')).toHaveValue('ws-t50')
        await form.locator('[data-related-new-workspace]').selectOption('ws-t50-other')
        await form.locator('[data-related-new-template]').selectOption(TEMPLATE.id)
        await form.locator('[data-related-new-name]').fill('T50 created')
        if (shots) await page.screenshot({ path: path.join(shots, 'related-new-session-1280.png') })
        await form.locator('[data-related-new-create]').click()

        // The dialog closes and the new session is on screen, running the template.
        await expect(dialog(page)).toHaveCount(0)
        let createdId = ''
        await expect.poll(() => {
            const other = configOnDisk(ctx!.userDataDir).workspaces.find(w => w.id === 'ws-t50-other')
            createdId = other?.sessions.find(s => s.name === 'T50 created')?.id ?? ''
            return createdId
        }, { timeout: 10_000 }).not.toBe('')
        await expect(button(page, createdId)).toBeVisible()
        await expect.poll(() => termText(page, createdId), { timeout: 15_000 }).toContain('T50-TEMPLATE-RAN')

        // Listed with the session it was started from, both ways round.
        await expect.poll(() => (configOnDisk(ctx!.userDataDir).sessionRelations ?? [])
            .some(r => !r.dismissed && r.kind === 'manual' && [r.from, r.to].sort().join() === [LEAD, createdId].sort().join())
        , { timeout: 10_000 }).toBe(true)
        await activateSession(page, NAMES[LEAD])
        await button(page, LEAD).click()
        await expect(dialog(page).locator(`[data-related-tree="manual"] [data-related-row="${createdId}"]`)).toBeVisible()
    })

    test('T50 narrow window keeps the new-session form inside the dialog', async () => {
        ctx = await launch()
        const { page } = ctx
        const shots = shotsDir()
        await resizeMainWindow(ctx.app, 390, 800)
        await activateSession(page, NAMES[LEAD])
        await button(page, LEAD).click()
        await dialog(page).locator('[data-related-new]').click()
        const panel = await dialog(page).locator('> div').nth(1).boundingBox()
        expect(panel).not.toBeNull()
        for (const selector of ['[data-related-new-workspace]', '[data-related-new-template]', '[data-related-new-create]', '[data-related-order]']) {
            const box = await dialog(page).locator(selector).boundingBox()
            expect(box, selector).not.toBeNull()
            expect(box!.x + box!.width, selector).toBeLessThanOrEqual(panel!.x + panel!.width + 1)
        }
        if (shots) await page.screenshot({ path: path.join(shots, 'related-new-session-390.png') })
    })
})
