import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T158 — the Settings list regrouped (report e3ac1981).
 *
 * The left list is four headed groups instead of thirteen flat buttons; Sidebar and Chat are new
 * tabs made of settings moved from General, Git (Local) and Terminal; the two terminal-link
 * settings sit together in Terminal; the old Hooks tab lives at the bottom of Agents; the
 * Notifications tab (Coming Soon only) is gone. Stored keys do not change — a moved switch still
 * writes the same key to config.json. `T158_SHOTS=<dir>` (+ T158_LABEL) leaves a capture per tab.
 * Fails on the code before it: there are no group headings and no Sidebar/Chat tabs.
 */
const GROUPS: [string, string[]][] = [
    ['App', ['general', 'keyboard', 'sidebar']],
    ['Sessions', ['terminal', 'chat', 'templates', 'agents']],
    ['Connections', ['phone', 'git', 'github', 'port-monitoring', 'loop']],
    ['Editor', ['editor']],
]

const SHOTS = process.env.T158_SHOTS
const LABEL = process.env.T158_LABEL ?? 'after'

test.describe('T158 settings groups', () => {
    let ctx: LaunchResult
    let dir: string

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        if (dir) fs.rmSync(dir, { recursive: true, force: true })
    })

    test('four groups; moved settings live in their new tabs and keep their keys', async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t158-'))
        ctx = await launchAppWithWorkspaces([
            { id: 'ws-a', name: 'T158WS', path: dir, sessions: [{ id: 's-a', name: 'T158SESS' }] }
        ])
        const { page } = ctx
        await page.setViewportSize({ width: 1500, height: 950 })
        await expect(page.getByText('T158WS', { exact: true }).first()).toBeVisible({ timeout: 15_000 })

        await page.locator('button[title^="Settings"]').first().click()
        const modal = page.locator('.w-\\[800px\\]')
        await expect(modal).toBeVisible()

        // The list: group headings in order, each with its tabs in order.
        const groups = modal.locator('[data-settings-group]')
        await expect(groups).toHaveCount(GROUPS.length)
        for (let g = 0; g < GROUPS.length; g++) {
            const [label, ids] = GROUPS[g]
            const group = groups.nth(g)
            await expect(group).toHaveAttribute('data-settings-group', label)
            const tabs = await group.locator('[data-testid^="settings-category-"]').evaluateAll(
                (els) => els.map((el) => el.getAttribute('data-testid')!.replace('settings-category-', ''))
            )
            expect(tabs, label).toEqual(ids)
        }
        await expect(modal.getByTestId('settings-category-hooks')).toHaveCount(0)
        await expect(modal.getByTestId('settings-category-notifications')).toHaveCount(0)
        // The list scrolls inside its column rather than spilling past the version box.
        const list = modal.locator('[data-settings-group]').first().locator('..')
        expect(await list.evaluate((el) => getComputedStyle(el).overflowY)).toBe('auto')

        const content = modal.locator('.flex-1.overflow-y-auto.p-6')
        const heading = (text: string) => content.locator('h3', { hasText: text })
        const shoot = async (id: string) => {
            if (!SHOTS) return
            fs.mkdirSync(SHOTS, { recursive: true })
            await modal.screenshot({ path: path.join(SHOTS, `${LABEL}-${id}.png`) })
        }

        // General keeps Appearance (theme), Feedback, Onboarding, Status command — no sidebar switches.
        await expect(heading('Appearance')).toBeVisible()
        await expect(content.getByText('Sidebar Font Size')).toHaveCount(0)
        await expect(heading('Home Workspace')).toHaveCount(0)
        await shoot('general')

        // Sidebar: font size, session count, worktrees, then the Home Workspace block with its switches.
        await modal.getByTestId('settings-category-sidebar').click()
        await expect(heading('Sidebar')).toBeVisible()
        for (const text of ['Sidebar Font Size', 'Show Session Count', 'Show Worktrees', 'Show Home Workspace']) {
            await expect(content.getByText(text, { exact: true })).toBeVisible()
        }
        for (const id of ['settings-show-playground', 'settings-show-session-tabs', 'settings-show-session-tree', 'settings-show-source-control', 'settings-show-session-status']) {
            await expect(content.getByTestId(id)).toHaveCount(1)
        }
        await shoot('sidebar')

        // Chat: the chat view settings, alone, first on the page.
        await modal.getByTestId('settings-category-chat').click()
        await expect(content.getByTestId('chat-view-settings')).toBeVisible()
        await shoot('chat')

        // Terminal: no chat settings; File Links sits right before App Links.
        await modal.getByTestId('settings-category-terminal').click()
        await expect(content.getByTestId('chat-view-settings')).toHaveCount(0)
        const order = await content.locator('h3').allTextContents()
        const files = order.indexOf('File Links in Terminal')
        expect(files, order.join(' | ')).toBeGreaterThan(-1)
        expect(order[files + 1]).toBe('App Links in Terminal')
        await shoot('terminal')

        // Editor: Default Editor only.
        await modal.getByTestId('settings-category-editor').click()
        expect(await content.locator('h3').allTextContents()).toEqual(['Default Editor'])
        await shoot('editor')

        // Agents: the old Hooks tab at the bottom.
        await modal.getByTestId('settings-category-agents').click()
        const agentHeadings = await content.locator('h3').allTextContents()
        expect(agentHeadings.map((h) => h.trim()).at(-1), agentHeadings.join(' | ')).toBe('Session Monitoring')
        expect(agentHeadings.some((h) => h.includes('Official Agent Hooks'))).toBe(true)
        await shoot('agents')

        // Git (Local): storage path and deletion options, no Show Worktrees.
        await modal.getByTestId('settings-category-git').click()
        await expect(heading('Git Worktree Settings')).toBeVisible()
        await expect(content.getByText('Show Worktrees', { exact: true })).toHaveCount(0)
        await shoot('git')

        // A moved switch writes the same key as before.
        await modal.getByTestId('settings-category-sidebar').click()
        const countRow = content.locator('div.flex.items-center.justify-between').filter({ hasText: 'Show Session Count' })
        await countRow.locator('button').first().click()
        await page.getByRole('button', { name: 'Save', exact: true }).click()
        await expect.poll(() => {
            const config = JSON.parse(fs.readFileSync(path.join(ctx.userDataDir, 'config.json'), 'utf8')) as { settings?: { showSessionCount?: boolean } }
            return config.settings?.showSessionCount
        }, { timeout: 10_000 }).toBe(true)
    })
})
