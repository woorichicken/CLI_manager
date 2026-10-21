import { test, expect } from '@playwright/test'
import { Terminal as HeadlessTerminal } from '@xterm/headless'
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { ILink, ILinkProvider } from '@xterm/xterm'
import {
    SESSION_LINK_REGEX,
    MAX_LINKED_SESSIONS,
    parseSessionLink,
    resolveSessionLink,
    describeSessionLinkProblems
} from '../../src/renderer/src/utils/sessionLink'
import type { TerminalSession, Workspace } from '../../src/shared/types'

/**
 * Pure unit tests for session links — no Electron.
 *
 * Detection runs through the real WebLinksAddon (the same instance type the
 * terminal loads) against a headless xterm buffer, so wrapping and coordinate
 * mapping are xterm's own, not a re-implementation.
 */

const ID_A = '02e9e098-baeb-4943-981a-a0ba5d7f9caf'
const ID_B = '47cc158f-7dbe-4deb-a5a7-17c368f094b5'
const ID_C = '9a1b2c3d-0000-4000-8000-000000000001'
// Shares its first 8 characters with ID_C, so the short ref `9a1b2c3d` is ambiguous.
const ID_C_TWIN = '9a1b2c3d-1111-4000-8000-000000000002'

function session(id: string, name = id.slice(0, 8)): TerminalSession {
    return { id, name, cwd: '/tmp', type: 'regular' }
}

function workspace(id: string, sessions: TerminalSession[]): Workspace {
    return { id, name: id, path: '/tmp', sessions, createdAt: 0 } as Workspace
}

const WORKSPACES = [
    workspace('w1', [session(ID_A), session(ID_C)]),
    workspace('w2', [session(ID_B), session(ID_C_TWIN)]),
    workspace('w3', [session('11111111-0000-4000-8000-000000000001'), session('22222222-0000-4000-8000-000000000002'), session('33333333-0000-4000-8000-000000000003')])
]

/** Links the real addon finds on each buffer row, as `row: text`. */
async function linksIn(output: string, cols: number): Promise<string[]> {
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
    new WebLinksAddon(() => undefined, { urlRegex: SESSION_LINK_REGEX }).activate(host as never)

    const found: string[] = []
    for (let y = 1; y <= term.buffer.active.length; y++) {
        provider!.provideLinks(y, (links: ILink[] | undefined) => {
            for (const link of links ?? []) found.push(`${link.range.start.y}: ${link.text}`)
        })
    }
    term.dispose()
    return [...new Set(found)]
}

test.describe('session link detection (real WebLinksAddon)', () => {
    test('finds a short link inside an agent sentence', async () => {
        const links = await linksIn('⏺ Continue in 「기타 수정」 climanager://session/02e9e098 when ready.\r\n', 100)
        expect(links).toEqual(['1: climanager://session/02e9e098'])
    })

    test('finds a full id and a comma list', async () => {
        const links = await linksIn(
            `one climanager://session/${ID_A}\r\nboth climanager://session/02e9e098,47cc158f, then stop\r\n`,
            100
        )
        expect(links).toEqual([`1: climanager://session/${ID_A}`, '2: climanager://session/02e9e098,47cc158f'])
    })

    test('a link the terminal soft-wraps is still one link', async () => {
        // 30 columns: the 57-character link wraps; xterm marks the next row as a continuation.
        const links = await linksIn(`climanager://session/${ID_A}\r\n`, 30)
        expect(links).toEqual([`1: climanager://session/${ID_A}`])
    })

    test('a link Claude Code hard-breaks with an indent is not rejoined', async () => {
        // What Claude Code 2.1.304 printed for a long path at 80 columns: a real
        // newline plus a 5-space indent. Only the head can be a link.
        // Head shorter than a ref: nothing becomes a link.
        expect(await linksIn('  ⎿  climanager://session/02e9e0\r\n     98-baeb-4943-981a-a0ba5d7f9caf\r\n', 80)).toEqual([])
        // Head of 8+ characters: it is a prefix ref, so it still reaches the right session.
        const links = await linksIn('  ⎿  climanager://session/02e9e098-baeb-49\r\n     43-981a-a0ba5d7f9caf\r\n', 80)
        expect(links).toEqual(['1: climanager://session/02e9e098-baeb-49'])
        const refs = parseSessionLink('climanager://session/02e9e098-baeb-49')!
        expect(resolveSessionLink(refs, WORKSPACES).sessions.map(s => s.session.id)).toEqual([ID_A])
    })

    test('ignores web links, other schemes and refs glued to a longer word', async () => {
        const links = await linksIn(
            'https://example.com/session/02e9e098 climanager://other/02e9e098 climanager://session/02e9e098zz climanager://session/02e9\r\n',
            160
        )
        expect(links).toEqual([])
    })
})

test.describe('parseSessionLink', () => {
    test('reads refs, lowercased and deduplicated, in order', () => {
        expect(parseSessionLink('climanager://session/02E9E098,47cc158f,02e9e098')).toEqual(['02e9e098', '47cc158f'])
        expect(parseSessionLink(`climanager://session/${ID_A}`)).toEqual([ID_A])
    })

    test('drops malformed refs and ignores a query', () => {
        expect(parseSessionLink('climanager://session/02e9e098,zz,1234?type=rm%20-rf')).toEqual(['02e9e098'])
    })

    test('returns null for anything that is not a session link', () => {
        expect(parseSessionLink('https://example.com/session/02e9e098')).toBeNull()
        expect(parseSessionLink('climanager://workspace/02e9e098')).toBeNull()
        expect(parseSessionLink('climanager://session/')).toBeNull()
        expect(parseSessionLink('climanager://session/1234')).toBeNull()
        expect(parseSessionLink('not a url')).toBeNull()
    })
})

test.describe('resolveSessionLink', () => {
    test('a short ref and a full id find their sessions, in link order', () => {
        const result = resolveSessionLink(['47cc158f', ID_A], WORKSPACES)
        expect(result.sessions.map(s => [s.workspace.id, s.session.id])).toEqual([['w2', ID_B], ['w1', ID_A]])
        expect(describeSessionLinkProblems(result)).toBeNull()
    })

    test('a closed session is reported, the others still open', () => {
        const result = resolveSessionLink(['deadbeef', '02e9e098'], WORKSPACES)
        expect(result.sessions.map(s => s.session.id)).toEqual([ID_A])
        expect(result.missing).toEqual(['deadbeef'])
        expect(describeSessionLinkProblems(result)).toContain('Session not found: deadbeef')
    })

    test('an ambiguous short ref opens nothing; the full id still works', () => {
        const short = resolveSessionLink(['9a1b2c3d'], WORKSPACES)
        expect(short.sessions).toEqual([])
        expect(short.ambiguous).toEqual(['9a1b2c3d'])

        const full = resolveSessionLink([ID_C], WORKSPACES)
        expect(full.sessions.map(s => s.session.id)).toEqual([ID_C])
    })

    test('the same session named twice opens once', () => {
        const result = resolveSessionLink(['02e9e098', ID_A], WORKSPACES)
        expect(result.sessions.map(s => s.session.id)).toEqual([ID_A])
    })

    test(`more than ${MAX_LINKED_SESSIONS} sessions keeps the first ${MAX_LINKED_SESSIONS}`, () => {
        const refs = ['02e9e098', '47cc158f', '11111111', '22222222', '33333333']
        const result = resolveSessionLink(refs, WORKSPACES)
        expect(result.sessions).toHaveLength(MAX_LINKED_SESSIONS)
        expect(result.sessions.map(s => s.session.id.slice(0, 8))).toEqual(refs.slice(0, MAX_LINKED_SESSIONS))
        expect(result.overflow).toBe(1)
        expect(describeSessionLinkProblems(result)).toContain(`first ${MAX_LINKED_SESSIONS}`)
    })
})
