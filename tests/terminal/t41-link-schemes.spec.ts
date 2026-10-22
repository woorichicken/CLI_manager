import { test, expect, type Page } from '@playwright/test'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import {
    buildLinkSchemeRegex,
    isLinkAllowed,
    normalizeLinkScheme,
    sanitizeLinkSchemes
} from '../../src/renderer/src/utils/terminalLinks'
import {
    launchAppWithSessions,
    closeApp,
    activateSession,
    writeToTerminal,
    termText,
    LaunchResult
} from './helpers'

/**
 * T41 — app links (`obsidian://…`) the user allowed in Settings > Terminal.
 *
 * Terminal output is untrusted, so a scheme outside the built-in list must do
 * nothing until the user adds it — both as plain text and as an OSC 8 link.
 * The unit half runs detection through the real WebLinksAddon on a headless
 * xterm buffer (as T33 does); the app half goes through the actual settings
 * screen and checks the far end, a stubbed shell.openExternal.
 */

/** Links the real addon finds with the given pattern, as `row: text`. */
async function linksIn(output: string, cols: number, urlRegex: RegExp): Promise<string[]> {
    const term = new HeadlessTerminal({ cols, rows: 10, allowProposedApi: true })
    await new Promise<void>(resolve => term.write(output, resolve))

    let provider: ILinkProvider | undefined
    const host = {
        buffer: term.buffer,
        cols: term.cols,
        rows: term.rows,
        registerLinkProvider: (p: ILinkProvider) => {
            provider = p
            return { dispose: () => undefined }
        }
    }
    new WebLinksAddon(() => undefined, { urlRegex }).activate(host as never)

    const found: string[] = []
    for (let y = 1; y <= term.buffer.active.length; y++) {
        provider!.provideLinks(y, (links: ILink[] | undefined) => {
            for (const link of links ?? []) found.push(`${link.range.start.y}: ${link.text}`)
        })
    }
    term.dispose()
    return [...new Set(found)]
}

test.describe('T41 scheme rules (unit)', () => {
    test('normalizes what the user types', () => {
        expect(normalizeLinkScheme('Obsidian')).toEqual({ scheme: 'obsidian' })
        expect(normalizeLinkScheme('obsidian:')).toEqual({ scheme: 'obsidian' })
        expect(normalizeLinkScheme('  obsidian://  ')).toEqual({ scheme: 'obsidian' })
        expect(normalizeLinkScheme('x-callback.app+v2')).toEqual({ scheme: 'x-callback.app+v2' })
    })

    test('refuses reserved, built-in, malformed and duplicate schemes', () => {
        for (const input of ['javascript', 'data:', 'climanager', 'https', 'vscode:', '', 'bad scheme', '1abc', 'a/b']) {
            expect(normalizeLinkScheme(input).error, input).toBeTruthy()
        }
        expect(normalizeLinkScheme('obsidian', ['obsidian']).error).toBeTruthy()
    })

    test('sanitizes a hand-edited list', () => {
        expect(sanitizeLinkSchemes([' Obsidian ', 'javascript', 'obsidian', 42 as unknown as string, 'things']))
            .toEqual(['obsidian', 'things'])
        expect(sanitizeLinkSchemes(undefined)).toEqual([])
    })

    test('allows built-ins always and extras only when listed', () => {
        expect(isLinkAllowed('https://example.com', [])).toBe(true)
        expect(isLinkAllowed('vscode://file/a.ts', [])).toBe(true)
        expect(isLinkAllowed('obsidian://open?vault=v', [])).toBe(false)
        expect(isLinkAllowed('obsidian://open?vault=v', ['obsidian'])).toBe(true)
        expect(isLinkAllowed('OBSIDIAN://open?vault=v', ['obsidian'])).toBe(true)
        expect(isLinkAllowed('things:///show?id=1', ['obsidian'])).toBe(false)
        // A reserved scheme stays blocked even if a config file lists it.
        expect(isLinkAllowed('javascript:alert(1)', ['javascript'])).toBe(false)
        expect(isLinkAllowed('not a url', ['obsidian'])).toBe(false)
    })

    test('builds no detector without a usable scheme', () => {
        expect(buildLinkSchemeRegex([])).toBeNull()
        expect(buildLinkSchemeRegex(['javascript', 'https'])).toBeNull()
    })
})

test.describe('T41 app link detection (real WebLinksAddon)', () => {
    const regex = buildLinkSchemeRegex(['obsidian'])!

    test('finds a link with a raw Hangul path inside a sentence', async () => {
        const links = await linksIn('⏺ 리뷰: obsidian://open?path=/Users/me/vault/리뷰/설계.md 확인 부탁\r\n', 120, regex)
        expect(links).toEqual(['1: obsidian://open?path=/Users/me/vault/리뷰/설계.md'])
    })

    test('finds the absolute-path shorthand (empty host)', async () => {
        // Obsidian documents `obsidian:///abs/path` as equal to `open?path=` — the shortest form an agent can print.
        const links = await linksIn('열기 obsidian:///Users/me/vault/리뷰%20메모.md\r\n', 100, regex)
        expect(links).toEqual(['1: obsidian:///Users/me/vault/리뷰%20메모.md'])
    })

    test('drops trailing punctuation and ignores look-alikes', async () => {
        const links = await linksIn(
            '(see obsidian://open?vault=v&file=a.)\r\n' +
            'xobsidian://open?vault=v\r\n' +
            'note: obsidian is installed\r\n' +
            'things://show?id=1\r\n' +
            'OBSIDIAN://open?vault=V\r\n',
            100,
            regex
        )
        expect(links).toEqual(['1: obsidian://open?vault=v&file=a', '5: OBSIDIAN://open?vault=V'])
    })

    test('keeps one link across an automatic wrap with wide characters', async () => {
        const url = 'obsidian://open?path=/vault/설계-리뷰/2026-10-22-링크-스킴.md'
        const links = await linksIn(`${url}\r\n`, 30, regex)
        expect(links).toEqual([`1: ${url}`])
    })
})

/** Click where the given text is painted (same approach as T14). */
async function clickText(page: Page, needle: string): Promise<void> {
    const findBox = () => page.evaluate((text) => {
        const nodes = Array.from(document.querySelectorAll('.xterm-rows *'))
            .filter(n => (n.textContent || '').includes(text))
        const el = nodes[nodes.length - 1]
        if (!el) return null
        const rect = el.getBoundingClientRect()
        if (!rect.width || !rect.height) return null
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
    }, needle)

    let box: { x: number, y: number } | null = null
    const deadline = Date.now() + 20_000
    while (!box && Date.now() < deadline) {
        box = await findBox()
        if (!box) await page.waitForTimeout(200)
    }
    if (!box) throw new Error(`"${needle}" was never painted in a row element`)

    await page.mouse.move(box.x, box.y)
    await page.waitForTimeout(200) // let xterm resolve the link under the cursor
    await page.mouse.click(box.x, box.y)
    await page.waitForTimeout(800)
}

async function openTerminalSettings(page: Page): Promise<void> {
    await page.locator('button[title="Settings"]').click()
    await page.getByRole('button', { name: 'Terminal', exact: true }).click()
    await expect(page.getByTestId('link-scheme-input')).toBeVisible()
}

test.describe('T41 app links in the running app', () => {
    let ctx: LaunchResult

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
    })

    test('obsidian links open only while the scheme is allowed', async () => {
        const PLAIN = 'obsidian://open?path=/tmp/t41/review.md'
        const OSC = 'obsidian://open?path=/tmp/t41/osc.md'

        ctx = await launchAppWithSessions([{ id: 'sess-t41', name: 'T41SESS' }])
        const { app, page } = ctx

        await app.evaluate(({ shell }) => {
            const opened: string[] = []
            ;(globalThis as unknown as { __opened: string[] }).__opened = opened
            shell.openExternal = async (url: string) => { opened.push(url) }
        })
        const opened = () => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

        await activateSession(page, 'T41SESS')
        await writeToTerminal(
            page,
            'sess-t41',
            `printf '${PLAIN}\\n\\033]8;;${OSC}\\033\\\\T41OSCLINK\\033]8;;\\033\\\\\\n'\n`
        )
        // The typed command echoes both strings too; wait for the printed lines themselves.
        await expect.poll(() => termText(page, 'sess-t41'), { timeout: 20_000 }).toMatch(/^T41OSCLINK\s*$/m)
        expect(await termText(page, 'sess-t41')).toMatch(/^obsidian:\/\/open\?path=\/tmp\/t41\/review\.md\s*$/m)

        // Not allowed yet: neither form reaches the OS.
        await clickText(page, PLAIN)
        await clickText(page, 'T41OSCLINK')
        expect(await opened()).toEqual([])

        // Allow it through the real settings screen. Built-ins are listed but locked.
        await openTerminalSettings(page)
        for (const builtin of ['http', 'https', 'file', 'vscode', 'cursor']) {
            await expect(page.getByTestId(`link-scheme-builtin-${builtin}`)).toBeVisible()
        }
        await expect(page.locator('[data-testid^="link-scheme-builtin-"] button')).toHaveCount(0)
        await page.getByTestId('link-scheme-input').fill('javascript')
        await page.getByTestId('link-scheme-add').click()
        await expect(page.getByTestId('link-scheme-error')).toBeVisible()
        await page.getByTestId('link-scheme-input').fill('Obsidian://')
        await page.getByTestId('link-scheme-input').press('Enter')
        await expect(page.getByTestId('link-scheme-item-obsidian')).toBeVisible()
        await page.getByRole('button', { name: 'Save', exact: true }).click()

        const saved = await page.evaluate(async () => {
            const api = (window as unknown as { api: { getSettings: () => Promise<{ terminalLinkSchemes?: string[] }> } }).api
            return (await api.getSettings()).terminalLinkSchemes
        })
        expect(saved).toEqual(['obsidian'])

        await clickText(page, PLAIN)
        await expect.poll(opened, { timeout: 10_000 }).toEqual([PLAIN])
        await clickText(page, 'T41OSCLINK')
        await expect.poll(opened, { timeout: 10_000 }).toEqual([PLAIN, OSC])

        // Removing it closes the door again.
        await openTerminalSettings(page)
        await page.getByTestId('link-scheme-remove-obsidian').click()
        await expect(page.getByTestId('link-scheme-item-obsidian')).toHaveCount(0)
        await page.getByRole('button', { name: 'Save', exact: true }).click()

        await clickText(page, PLAIN)
        await clickText(page, 'T41OSCLINK')
        expect(await opened()).toEqual([PLAIN, OSC])
    })
})
