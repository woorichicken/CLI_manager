import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
    launchAppWithWorkspaces,
    closeApp,
    activateSession,
    writeToTerminal,
    termText,
    LaunchResult
} from './helpers'

/**
 * T12 — a shrinking workspace list must not remount terminals.
 *
 * Terminals render as one array per workspace. Those arrays need a stable key:
 * without one React matches them by index, so dropping a workspace shifts every
 * later position and remounts the TerminalViews there. The pty survives that
 * (TerminalManager skips ids it already owns) but the xterm buffer does not —
 * which is what "Reload Worktrees reset all my terminals" actually was.
 *
 * Reload is the trigger used here because it is the reported one: it re-reads
 * the store into React state, so a workspace that disappeared from the store
 * disappears from the middle of the rendered list.
 *
 * The signal is DOM node identity, tagged before the change: a remount replaces
 * the element, so the tag is gone. Scrollback is checked too, because that is
 * what the user actually loses. Both are read only after the removed session's
 * element is gone — the deletion and the remount land in the same commit, so
 * that gate cannot pass before the outcome is decided.
 */

const MARKER = 'MARKER_T12_SURVIVES'
const PROBE_TAG = '__t12Probe'

type NodeState = 'gone' | 'same-node' | 'remounted'

interface TestApi {
    removeWorkspace: (id: string) => Promise<unknown>
}

test.describe('T12 workspace list remount', () => {
    let ctx: LaunchResult
    const tempDirs: string[] = []

    const tempWorkspaceDir = (): string => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t12-'))
        tempDirs.push(dir)
        return dir
    }

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        for (const dir of tempDirs.splice(0)) {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('dropping a workspace keeps the terminals after it alive', async () => {
        // Plain directories, not repos: the startup worktree scan skips them, so
        // the only change to the list is the one this test makes.
        const firstDir = tempWorkspaceDir()
        const middleDir = tempWorkspaceDir()
        const lastDir = tempWorkspaceDir()

        ctx = await launchAppWithWorkspaces([
            { id: 'ws-first', name: 'T12FIRST', path: firstDir, sessions: [{ id: 's-first', name: 'T12SESSFIRST' }] },
            { id: 'ws-middle', name: 'T12MIDDLE', path: middleDir, sessions: [{ id: 's-middle', name: 'T12SESSMID' }] },
            // Rendered after the one that disappears — this is the terminal that
            // used to be remounted.
            { id: 'ws-last', name: 'T12LAST', path: lastDir, sessions: [{ id: 's-last', name: 'T12SESSLAST' }] }
        ])
        const { page } = ctx

        const nodeState = (sessionId: string): Promise<NodeState> => page.evaluate(
            ([id, tag]) => {
                const el = document.querySelector(`[data-session-id="${id}"]`) as
                    (HTMLElement & Record<string, unknown>) | null
                if (!el) return 'gone' as NodeState
                return (el[tag] === 1 ? 'same-node' : 'remounted') as NodeState
            },
            [sessionId, PROBE_TAG] as [string, string]
        )

        // Put a marker in the last workspace's terminal.
        await activateSession(page, 'T12SESSLAST')
        await writeToTerminal(page, 's-last', `echo ${MARKER}\n`)
        await expect
            .poll(() => termText(page, 's-last'), { timeout: 20_000 })
            .toContain(MARKER)

        // Tag the mounted terminal elements.
        const tagged = await page.evaluate(
            (tag) => ['s-first', 's-middle', 's-last'].every(id => {
                const el = document.querySelector(`[data-session-id="${id}"]`) as
                    (HTMLElement & Record<string, unknown>) | null
                if (!el) return false
                el[tag] = 1
                return true
            }),
            PROBE_TAG
        )
        expect(tagged, 'all three terminals mounted before the change').toBe(true)

        // Drop the middle workspace from the store, then make the renderer
        // re-read it — the Reload Worktrees path.
        await page.evaluate(() =>
            (window as unknown as { api: TestApi }).api.removeWorkspace('ws-middle'))
        await page.getByText('T12FIRST', { exact: true }).first().click({ button: 'right' })
        await page.getByText('Reload Worktrees', { exact: true }).click()

        // Gate: the rendered list really did shrink in the middle.
        await expect.poll(() => nodeState('s-middle'), { timeout: 20_000 }).toBe('gone')

        // The terminal after the removed one was never rebuilt, and kept its buffer.
        expect(await nodeState('s-last'), 's-last must not be remounted').toBe('same-node')
        expect(await termText(page, 's-last')).toContain(MARKER)
    })
})
