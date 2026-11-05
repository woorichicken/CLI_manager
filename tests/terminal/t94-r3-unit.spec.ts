import { test, expect } from '@playwright/test'
import { EventEmitter } from 'events'
import { TerminalMirror } from '../../src/main/TerminalMirror'
import { ConversationService } from '../../src/main/ConversationService'
import { TranscriptReader } from '../../src/main/TranscriptReader'
import { isBusyRow } from '../../src/main/screenLines'
import { readPrompt } from '../../src/main/promptScreen'
import { activeTrigger, codeIsSessionLink, rankCommands, splitSessionLinks } from '../../src/renderer/src/components/ChatView/chatLib'
import { searchLines } from '../../src/renderer/src/phone/sessionListLines'
import type { ChatCommand } from '../../src/shared/conversation'
import type { PhoneSession, PhoneSessionsResponse } from '../../src/shared/phone'

/**
 * T94 — phone-fixes round 3 (11-05), without Electron.
 *
 * 4359b4ee · cb052f3b: Claude Code 2.1.318 no longer prints "esc to interrupt" while a turn runs. A real
 * 2.1.318 session recorded on 11-05 (103×43, 41.8s) held the hint 0 times; its spinner rows were
 * `✳ Galloping… (8s · ↓ 527 tokens)` and `✻ Deciphering… (running UserPromptSubmit hooks… 0/2 · 0s)`, and
 * the settled turn's `✻ Cogitated for 11s · done 10:42 PM`. The chat read every running turn as idle: no
 * «working» row, no spinner, a Stop refused. The rows below are copied from that recording.
 *
 * c21d4b5a · 574c78e4: `/` opened the skill menu only at a line's start (`1번 /a` did nothing).
 * b2020233: a `climanager://session/…` link in a chat answer was plain words.
 * 1b92a570: the phone's session list had no search.
 */

const RUNNING_318 = [
    '✳ Galloping… (8s · ↓ 527 tokens)',
    '✻ Galloping… (5s · thinking with high effort)',
    '✻ Deciphering… (running UserPromptSubmit hooks… 0/2 · 0s)',
    '· Deciphering… (1s · ↓ 1 tokens)',
    '✢ Skedaddling… (2m 36s · ↓ 1.8k tokens)'
]
const SETTLED_318 = ['✻ Cogitated for 11s · done 10:42 PM', '✻ Sautéed for 1s · done 10:42 PM', '✻ Worked for 41s']

const COLS = 103
const ROWS = 24
const RULE = '─'.repeat(COLS)

function screenWith(status: string[]): string[] {
    return ['❯ Count slowly from 1 to 40', '', ...status, RULE, '❯ ', RULE, '  ⏵⏵ bypass permissions on (shift+tab to cycle)']
}

async function mirrorShowing(rows: string[]): Promise<TerminalMirror> {
    const events = new EventEmitter()
    const mirror = new TerminalMirror({ events, getSize: () => ({ cols: COLS, rows: ROWS }), hasTerminal: () => true } as never)
    events.emit('created', 's1', COLS, ROWS)
    events.emit('output', 's1', rows.join('\r\n'))
    await mirror.flush('s1')
    return mirror
}

function conversations(mirror: TerminalMirror) {
    const written: string[] = []
    const service = new ConversationService({
        session: () => ({ cwd: '/w', cliSessionId: undefined, cliToolName: 'claude' }),
        reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
        mirror,
        hasTerminal: () => true,
        writeInput: (_id: string, data: string) => void written.push(data),
        type: async () => true,
        onChange: () => undefined
    })
    return { service, written }
}

test.describe('T94 a turn in progress on Claude Code 2.1.318 (4359b4ee · cb052f3b)', () => {
    test('the spinner rows without "esc to interrupt" are busy; settled rows and prose are not', () => {
        for (const row of RUNNING_318) expect(isBusyRow(row), row).toBe(true)
        for (const row of SETTLED_318) expect(isBusyRow(row), row).toBe(false)
        // the old hint still counts (Codex, older Claude Code)
        expect(isBusyRow('✻ Working… (esc to interrupt)')).toBe(true)
        expect(isBusyRow('• Working (12s • Esc to interrupt)')).toBe(true)
        // words that only look a little like it
        for (const row of ['Loading… (see the docs)', '⏺ Galloping… (8s)', '  - Galloping… (8s)', '✻ Galloping…', '✻ (8s)', '⎿ Running… (3s)']) {
            expect(isBusyRow(row), row).toBe(false)
        }
    })

    test('the mirror and the chat read the 2.1.318 screen as working; a settled one as idle', async () => {
        const running = await mirrorShowing(screenWith([RUNNING_318[0]]))
        expect(running.showsBusy('s1')).toBe(true)
        expect(running.screenStatus('s1').busy).toBe(true)
        const chat = conversations(running)
        expect((await chat.service.getConversation('s1')).working).toBe(true)

        const settled = await mirrorShowing(screenWith([SETTLED_318[0]]))
        expect(settled.showsBusy('s1')).toBe(false)
        expect((await conversations(settled).service.getConversation('s1')).working).toBe(false)
    })

    test('Stop reaches a 2.1.318 turn (Esc), and is still refused at rest', async () => {
        const running = conversations(await mirrorShowing(screenWith([RUNNING_318[2]])))
        expect((await running.service.interrupt('s1')).status).toBe('stopped')
        expect(running.written).toEqual(['\x1b'])
        const idle = conversations(await mirrorShowing(screenWith([SETTLED_318[0]])))
        expect((await idle.service.interrupt('s1')).status).toBe('rejected')
        expect(idle.written).toEqual([])
    })

    test('a menu is not read under a 2.1.318 spinner', () => {
        const rows = [...screenWith([RUNNING_318[0]]), ' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', ' Esc to cancel']
        expect(readPrompt(rows, 'claude')).toBeNull()
    })
})

const COMMANDS: ChatCommand[] = [
    { name: 'model', description: 'Switch the model', source: 'builtin' },
    { name: 'clear', description: 'Clear', source: 'builtin' },
    { name: 'climanager-session', description: 'Open a session', source: 'skill' },
    { name: 'progress-report', description: 'Report', source: 'skill', uses: 41 },
    { name: 'deploy', description: 'Deploy', source: 'command' },
    { name: 'codex-skill', description: 'A Codex skill', source: 'skill', trigger: '$' }
]

test.describe('T94 a skill after other words (c21d4b5a · 574c78e4)', () => {
    test('`/` after a space opens the menu mid-line, with skills and own commands only', () => {
        const text = '1번 /a'
        const trigger = activeTrigger(text, text.length, false)
        expect(trigger).toEqual({ kind: 'slash', prefix: '/', query: 'a', start: 3, inline: true })
        if (trigger?.kind !== 'slash') throw new Error('no trigger')
        const bare = activeTrigger('어떻게 해결한거야? /', 13, false)
        if (bare?.kind !== 'slash') throw new Error('no trigger')
        const names = rankCommands(COMMANDS, bare, {}).map((command) => command.name)
        expect(names).toEqual(['progress-report', 'climanager-session', 'deploy'])
        expect(rankCommands(COMMANDS, { ...bare, query: 'mo' }, {})).toEqual([])
    })

    test('the second line of a message and a line start are as before (built-ins listed)', () => {
        const text = '그리고 키는\n/mo'
        const trigger = activeTrigger(text, text.length, false)
        expect(trigger).toEqual({ kind: 'slash', prefix: '/', query: 'mo', start: 7 })
        if (trigger?.kind !== 'slash') throw new Error('no trigger')
        expect(rankCommands(COMMANDS, trigger, {}).map((command) => command.name)).toEqual(['model'])
    })

    test('paths and words with a slash never open it', () => {
        for (const text of ['see src/a', 'open ~/x', 'a/b', 'cd ./re', 'http://x/y', '1/2']) {
            expect(activeTrigger(text, text.length, false), text).toBeNull()
        }
    })

    test('Codex: `$skill` mid-line, its `/` commands only at a line start', () => {
        expect(activeTrigger('use $co', 7, true)).toEqual({ kind: 'slash', prefix: '$', query: 'co', start: 4, inline: true })
        expect(activeTrigger('use /pro', 8, true)).toBeNull()
        expect(activeTrigger('use $co', 7, false)).toBeNull()
    })
})

test.describe('T94 session links in a chat answer (b2020233)', () => {
    test('the terminal\'s matcher cuts them out of text and code', () => {
        expect(splitSessionLinks('그 세션: climanager://session/be5c9a25 에서 보세요')).toEqual([
            '그 세션: ',
            { sessionLink: 'climanager://session/be5c9a25' },
            ' 에서 보세요'
        ])
        expect(splitSessionLinks('two climanager://session/be5c9a25,0aab59f7.')).toEqual(['two ', { sessionLink: 'climanager://session/be5c9a25,0aab59f7' }, '.'])
        expect(splitSessionLinks('climanager://session/xyz')).toEqual(['climanager://session/xyz'])
        expect(codeIsSessionLink('climanager://session/be5c9a25')).toBe(true)
        expect(codeIsSessionLink('open climanager://session/be5c9a25')).toBe(false)
        expect(codeIsSessionLink('climanager://session/be5c9a25zz')).toBe(false)
    })
})

function phoneSession(id: string, name: string, workspaceName: string, sessionFolderId?: string): PhoneSession {
    return { id, name, workspaceId: `w-${workspaceName}`, workspaceName, agent: 'claude', state: 'idle', sessionFolderId } as PhoneSession
}

test.describe('T94 phone session search (1b92a570)', () => {
    const data: PhoneSessionsResponse = {
        sessions: [
            phoneSession('a', 'EFM 팀장', 'e-fm-saechang'),
            phoneSession('b', '대화: 메타 해커톤', 'contest', 'f1'),
            phoneSession('c', '킷츠 팀장', 'prj-kits'),
            phoneSession('d', '업무 소통용', 'e-fm-saechang')
        ],
        sessionFolders: [{ id: 'f1', name: '공모전 10-28' }]
    }
    const names = (query: string) => searchLines(data, query)?.map((line) => (line.kind === 'row' ? line.session.name : line.kind))

    test('every word in the name, the workspace or the folder, any case; in the Mac order; flat', () => {
        expect(names('팀장')).toEqual(['EFM 팀장', '킷츠 팀장'])
        expect(names('efm')).toEqual(['EFM 팀장'])
        expect(names('SAECHANG')).toEqual(['EFM 팀장', '업무 소통용'])
        expect(names('e-fm 소통')).toEqual(['업무 소통용'])
        expect(names('공모전')).toEqual(['대화: 메타 해커톤'])
        expect(names('없는말')).toEqual([])
    })

    test('an empty box is no search', () => {
        expect(searchLines(data, '')).toBeNull()
        expect(searchLines(data, '   ')).toBeNull()
    })
})
