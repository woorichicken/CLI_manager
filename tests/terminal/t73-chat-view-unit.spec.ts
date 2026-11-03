import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseClaudeTranscript } from '../../src/main/transcript/claudeTranscript'
import { parseCodexTranscript } from '../../src/main/transcript/codexTranscript'
import { TranscriptReader, claudeProjectSlug } from '../../src/main/TranscriptReader'
import { answerSteps, KEYS, readPrompt } from '../../src/main/promptScreen'
import type { ConversationPart, ConversationTurn } from '../../src/shared/conversation'

/**
 * T73 — Chat view, without Electron.
 *
 * Transcripts are the synthetic ones in fixtures/transcripts (make-fixtures.py —
 * real ones hold names, paths and secrets). Expected values are read out of the
 * fixture files by a plain JSON scan here, not typed by hand. Question screens
 * are copies of real Claude Code 2.1.312 screens (fixtures/prompts, the session
 * header with the path and id cut off).
 */

const FIXTURES = path.join(__dirname, 'fixtures')
const claudeFile = (name: string): string => path.join(FIXTURES, 'transcripts/claude', name)
const read = (file: string): string => fs.readFileSync(file, 'utf8')
const records = (file: string): Record<string, any>[] =>
    read(file).split('\n').flatMap((line) => {
        try {
            return [JSON.parse(line)]
        } catch {
            return []
        }
    })

/** The person's typed prompts, straight from the file: string content that is no command or meta record. */
function typedPrompts(file: string): string[] {
    return records(file)
        .filter((e) => e.type === 'user' && !e.isMeta && !e.isCompactSummary && typeof e.message?.content === 'string' && !e.message.content.startsWith('<'))
        .map((e) => e.message.content as string)
}
/** The last answer text, straight from the file: the last end_turn assistant record's text blocks. */
function lastAnswer(file: string): string {
    const last = records(file).filter((e) => e.type === 'assistant' && e.message?.stop_reason === 'end_turn').at(-1)
    return (last?.message.content as { type: string; text?: string }[]).filter((b) => b.type === 'text').map((b) => b.text).join('')
}
const texts = (turn: ConversationTurn | undefined, kind: ConversationPart['kind'] = 'text'): string[] =>
    (turn?.parts ?? []).filter((p) => p.kind === kind).map((p) => ('text' in p ? (p as { text: string }).text : ''))
const userTexts = (turns: ConversationTurn[]): string[] => turns.filter((t) => t.role === 'user').flatMap((t) => texts(t))
const lastAssistantText = (turns: ConversationTurn[]): string => texts(turns.filter((t) => t.role === 'assistant').at(-1)).join('')

test.describe('T73 Claude transcript parsing (ported from ovis)', () => {
    for (const name of ['short.jsonl', 'tools.jsonl', 'denied.jsonl', 'compacted.jsonl']) {
        test(`${name}: every typed prompt is a user turn, and the last answer matches the file`, () => {
            const turns = parseClaudeTranscript(read(claudeFile(name)))
            expect(userTexts(turns)).toEqual(typedPrompts(claudeFile(name)))
            expect(lastAssistantText(turns)).toBe(lastAnswer(claudeFile(name)))
        })
    }

    test('tools.jsonl: tools fold into one assistant turn with results; bookkeeping records are ignored', () => {
        const turns = parseClaudeTranscript(read(claudeFile('tools.jsonl')))
        expect(turns.map((t) => t.role)).toEqual(['user', 'assistant'])
        const tools = turns[1].parts.filter((p): p is Extract<ConversationPart, { kind: 'tool' }> => p.kind === 'tool')
        const fromFile = records(claudeFile('tools.jsonl')).flatMap((e) => (e.type === 'assistant' ? e.message.content : [])).filter((b: any) => b.type === 'tool_use')
        expect(tools.map((t) => t.name)).toEqual(fromFile.map((b: any) => b.name))
        expect(tools.every((t) => t.state === 'ok')).toBe(true)
        expect(tools[0].summary).toBe('Read the file') // the description Claude gave the Bash call
        expect(turns[1].parts.some((p) => p.kind === 'thinking')).toBe(true)
        // the api-request-blob record's text never becomes a turn
        expect(JSON.stringify(turns)).not.toContain('internal request copy')
        const final = turns[1].parts.at(-1)
        expect(final?.kind === 'text' && final.phase).toBe('final_answer')
    })

    test('resent.jsonl: a send cancelled before any reply shows only the re-send', () => {
        const turns = parseClaudeTranscript(read(claudeFile('resent.jsonl')))
        expect(userTexts(turns)).toEqual(['Hello there', 'The message I really sent'])
    })

    test('compacted.jsonl: the compaction summary is a compact part between the turns', () => {
        const turns = parseClaudeTranscript(read(claudeFile('compacted.jsonl')))
        const summary = records(claudeFile('compacted.jsonl')).find((e) => e.isCompactSummary).message.content
        const compact = turns.find((t) => t.parts.some((p) => p.kind === 'compact'))
        expect(texts(compact, 'compact')).toEqual([summary])
    })

    test('cleared.jsonl: /clear starts over — only what came after it', () => {
        const turns = parseClaudeTranscript(read(claudeFile('cleared.jsonl')))
        expect(userTexts(turns)).toEqual(['After clear'])
        expect(lastAssistantText(turns)).toBe(lastAnswer(claudeFile('cleared.jsonl')))
    })

    test('subagent.jsonl: the task notification is a task_result card titled from its summary', () => {
        const turns = parseClaudeTranscript(read(claudeFile('subagent.jsonl')))
        const notice = records(claudeFile('subagent.jsonl')).map((e) => e.message?.content).find((c) => typeof c === 'string' && c.startsWith('<task-notification>')) as string
        const title = /<summary>Agent "(.*)" completed<\/summary>/.exec(notice)![1]
        const result = /<result>([\s\S]*)<\/result>/.exec(notice)![1]
        const card = turns.flatMap((t) => t.parts).find((p) => p.kind === 'task_result')
        expect(card?.kind === 'task_result' && card.tasks.map((task) => [task.title, task.result, task.status])).toEqual([[title, result, 'completed']])
    })

    test('image.jsonl: a pasted picture is named (type by its bytes) beside the words', () => {
        const turns = parseClaudeTranscript(read(claudeFile('image.jsonl')))
        expect(turns[0].parts.map((p) => p.kind)).toEqual(['image', 'text'])
        expect(turns[0].parts[0].kind === 'image' && turns[0].parts[0].media_type).toBe('image/png')
    })

    test('denied.jsonl: a refused permission marks the call failed', () => {
        const turns = parseClaudeTranscript(read(claudeFile('denied.jsonl')))
        const tool = turns[1].parts.find((p) => p.kind === 'tool')
        expect(tool?.kind === 'tool' && [tool.error, tool.state]).toEqual([true, 'error'])
    })

    test('queued.jsonl: a message typed mid-turn (queued_command) is a user turn', () => {
        const turns = parseClaudeTranscript(read(claudeFile('queued.jsonl')))
        const queued = records(claudeFile('queued.jsonl')).find((e) => e.type === 'attachment').attachment.prompt
        expect(userTexts(turns)).toContain(queued)
    })

    test('working.jsonl: a call with no result yet is pending, and a torn last line is not an error', () => {
        const turns = parseClaudeTranscript(read(claudeFile('working.jsonl')))
        const tool = turns.at(-1)?.parts.find((p) => p.kind === 'tool')
        expect(tool?.kind === 'tool' && tool.state).toBe('pending')
    })
})

test.describe('T73 Codex rollout parsing (ported from ovis)', () => {
    test('the prompt shows once (event + response copies), context records are hidden, the command and answer are read', () => {
        const file = path.join(FIXTURES, 'transcripts/codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl')
        const turns = parseCodexTranscript(read(file))
        const typed = records(file).filter((e) => e.type === 'event_msg' && e.payload.type === 'user_message').map((e) => e.payload.message)
        const answer = records(file).filter((e) => e.type === 'event_msg' && e.payload.type === 'agent_message').at(-1)!.payload.message
        expect(userTexts(turns)).toEqual(typed)
        expect(lastAssistantText(turns)).toBe(answer)
        const tool = turns.at(-1)?.parts.find((p) => p.kind === 'tool')
        expect(tool?.kind === 'tool' && [tool.name, tool.summary]).toEqual(['exec_command', 'ls'])
        expect(JSON.stringify(turns)).not.toContain('environment_context')
    })
})

test.describe('T73 TranscriptReader', () => {
    const scratch = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'climanager-t73-'))

    test('finds a Claude file by the cwd slug, and by scanning when the cwd moved', () => {
        const home = scratch()
        const id = '00000000-0000-4000-8000-0000000000aa'
        const cwd = '/Users/someone/my_project.v2'
        fs.mkdirSync(path.join(home, 'projects', claudeProjectSlug(cwd)), { recursive: true })
        fs.copyFileSync(claudeFile('short.jsonl'), path.join(home, 'projects', claudeProjectSlug(cwd), `${id}.jsonl`))
        const reader = new TranscriptReader({ claudeConfigDir: () => home, codexHome: () => home })
        expect(claudeProjectSlug(cwd)).toBe('-Users-someone-my-project-v2')
        expect(reader.locate('claude', id, cwd)).toHaveLength(1)
        expect(reader.locate('claude', id, '/somewhere/else')).toHaveLength(1)
        expect(reader.locate('claude', 'not a uuid/../x')).toEqual([])
    })

    test('reads only what was appended, holds a torn line until it is whole, and starts over when the file shrinks', () => {
        const home = scratch()
        const id = '00000000-0000-4000-8000-0000000000bb'
        const dir = path.join(home, 'projects', 'p')
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `${id}.jsonl`)
        const lines = read(claudeFile('tools.jsonl')).trimEnd().split('\n')
        fs.writeFileSync(file, lines.slice(0, 2).join('\n') + '\n')
        const reader = new TranscriptReader({ claudeConfigDir: () => home, codexHome: () => home })
        const first = reader.read('s', 'claude', id)!
        expect(first.changed).toBe(true)
        expect(reader.read('s', 'claude', id)!.changed).toBe(false)
        // the rest, with the last line cut in the middle (a write in progress)
        const rest = lines.slice(2).join('\n') + '\n'
        const cut = rest.length - 20
        fs.appendFileSync(file, rest.slice(0, cut))
        const partial = reader.read('s', 'claude', id)!
        fs.appendFileSync(file, rest.slice(cut))
        const whole = reader.read('s', 'claude', id)!
        expect(whole.changed).toBe(true)
        expect(lastAssistantText(whole.turns)).toBe(lastAnswer(claudeFile('tools.jsonl')))
        expect(JSON.stringify(partial.turns)).not.toContain(lastAnswer(claudeFile('tools.jsonl')))
        // replaced by a shorter file: read again from the start
        fs.writeFileSync(file, read(claudeFile('short.jsonl')))
        const again = reader.read('s', 'claude', id)!
        expect(userTexts(again.turns)).toEqual(typedPrompts(claudeFile('short.jsonl')))
    })

    test('a file over the first-read budget is read from its end and says so', () => {
        const home = scratch()
        const id = '00000000-0000-4000-8000-0000000000cc'
        fs.mkdirSync(path.join(home, 'projects', 'p'), { recursive: true })
        const file = path.join(home, 'projects', 'p', `${id}.jsonl`)
        fs.writeFileSync(file, read(claudeFile('cleared.jsonl')).replace('<command-name>/clear', '<command-name>/other') + read(claudeFile('short.jsonl')))
        const budget = fs.statSync(claudeFile('short.jsonl')).size + 10
        const reader = new TranscriptReader({ claudeConfigDir: () => home, codexHome: () => home, firstReadBytes: budget })
        const result = reader.read('s', 'claude', id)!
        expect(result.truncated).toBe(true)
        expect(userTexts(result.turns)).toEqual(typedPrompts(claudeFile('short.jsonl')))
    })

    test('a Codex thread split into segments is read in order', () => {
        const home = scratch()
        const id = '00000000-0000-4000-8000-0000000000dd'
        const day = path.join(home, 'sessions', '2026', '11', '03')
        fs.mkdirSync(day, { recursive: true })
        const source = read(path.join(FIXTURES, 'transcripts/codex/rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000c1.jsonl')).trimEnd().split('\n')
        fs.writeFileSync(path.join(day, `rollout-2026-11-03T10-00-00-${id}.jsonl`), source.slice(0, 5).join('\n') + '\n')
        fs.writeFileSync(path.join(day, `rollout-2026-11-03T10-00-00-${id}_00000000-0000-4000-8000-000000000002.jsonl`), source.slice(5).join('\n') + '\n')
        fs.writeFileSync(path.join(day, 'rollout-2026-11-03T10-00-00-00000000-0000-4000-8000-0000000000ee.jsonl'), '')
        const reader = new TranscriptReader({ claudeConfigDir: () => home, codexHome: () => home })
        expect(reader.locate('codex', id)).toHaveLength(2)
        const result = reader.read('s', 'codex', id)!
        expect(lastAssistantText(result.turns)).toContain('two')
    })
})

test.describe('T73 question menus off the screen (promptScreen)', () => {
    const screen = (name: string): string[] => read(path.join(FIXTURES, 'prompts', name)).replace(/\s+$/, '').split('\n')

    test('real 2.1.312 permission prompt: question, the command as context, four options, Yes highlighted', () => {
        const menu = readPrompt(screen('claude-2.1.312-permission.txt'), 'claude')!
        expect(menu.kind).toBe('permission')
        expect(menu.question).toBe('Do you want to proceed?')
        expect(menu.context).toContain('touch /tmp/fb1029b-perm-probe')
        expect(menu.options.map((o) => [o.number, o.label.split(' ')[0], o.selected])).toEqual([
            [1, 'Yes', true],
            [2, 'Yes,', false],
            [3, 'Yes,', false],
            [4, 'No', false]
        ])
        expect(menu.answerable).toBe(true)
        // "No" is three rows down from the highlighted "Yes"
        expect(answerSteps(menu, { signature: menu.signature, optionIndex: 3 })).toEqual([{ key: KEYS.down }, { key: KEYS.down }, { key: KEYS.down }, { key: KEYS.enter }])
    })

    test('real 2.1.312 AskUserQuestion: options with descriptions, "Type something." takes words, "Chat about this" below the rule', () => {
        const menu = readPrompt(screen('claude-2.1.312-askuserquestion.txt'), 'claude')!
        expect(menu.kind).toBe('question')
        expect(menu.question).toBe('어떤 색이 좋아?')
        expect(menu.context).toEqual(['☐ 색 선택'])
        expect(menu.options.map((o) => o.label)).toEqual(['빨강', '파랑', 'Type something.', 'Chat about this'])
        expect(menu.options[0].description).toBe('빨간색을 선택합니다')
        expect(menu.options[2].custom).toBe(true)
        expect(answerSteps(menu, { signature: menu.signature, customText: ' 초록\n색 ' })).toEqual([{ key: KEYS.down }, { key: KEYS.down }, { text: '초록 색' }, { key: KEYS.enter }])
        expect(() => answerSteps(menu, { signature: menu.signature, optionIndex: 2 })).toThrow()
    })

    test('the signature changes when the highlight moves or the command differs', () => {
        const lines = screen('claude-2.1.312-permission.txt')
        const before = readPrompt(lines, 'claude')!
        const moved = readPrompt(lines.map((line) => line.replace(' ❯ 1. Yes', '   1. Yes').replace('   4. No', ' ❯ 4. No')), 'claude')!
        const other = readPrompt(lines.map((line) => line.replace(' touch /tmp/fb1029b-perm-probe', ' rm -rf /tmp/other')), 'claude')!
        expect(moved.options[3].selected).toBe(true)
        expect(new Set([before.signature, moved.signature, other.signature]).size).toBe(3)
    })

    test('no menu while the agent works, or when dialog words sit above an idle input box', () => {
        const rule = '─'.repeat(98)
        expect(readPrompt(['  Enter to select · Esc to cancel', '✻ Working… (3s · esc to interrupt)', rule, '❯ ', rule], 'claude')).toBeNull()
        expect(readPrompt(['  4. Chat about this', '  Enter to select · ↑/↓ to navigate · Esc to cancel', '', '✻ Sautéed for 35s', rule, '❯ ', rule, '  ⏵⏵ bypass permissions on'], 'claude')).toBeNull()
        expect(readPrompt(['● Done.', rule, '❯ ', rule], 'claude')).toBeNull()
    })

    test('folder trust (unnumbered options) is answerable; Codex menus and multiple choice are terminal-only', () => {
        const trust = readPrompt([' Quick safety check: Is this a project you created or one you trust?', ' ❯ No, exit', '   Yes, I trust this folder', ' Enter to confirm · Esc to cancel'], 'claude')!
        expect(trust.kind).toBe('trust')
        expect(trust.options.map((o) => [o.label, o.selected])).toEqual([['No, exit', true], ['Yes, I trust this folder', false]])
        expect(answerSteps(trust, { signature: trust.signature, optionIndex: 1 })).toEqual([{ key: KEYS.down }, { key: KEYS.enter }])

        const codex = readPrompt(['Do you trust the contents of this directory?', '› 1. Yes, continue', '  2. No, quit', 'Press enter to continue'], 'codex')!
        expect([codex.kind, codex.answerable, codex.options.length]).toEqual(['trust', false, 2])
        expect(() => answerSteps(codex, { signature: codex.signature, optionIndex: 0 })).toThrow()

        const multi = readPrompt(['Which ones?', '❯ 1. [ ] Red', '  2. [✔] Blue', '  3. Submit', 'Enter to select · ↑/↓ to navigate · Esc to cancel'], 'claude')!
        expect([multi.multi, multi.answerable]).toEqual([true, false])
    })

    test('a numbered list in the answer above the dialog is not taken for its options', () => {
        const lines = ['⏺ Plan:', '  1. Read the file', '  2. Edit it', '  3. Run tests', ...screen('claude-2.1.312-permission.txt')]
        const menu = readPrompt(lines, 'claude')!
        expect(menu.options.map((o) => o.number)).toEqual([1, 2, 3, 4])
        expect(menu.options[0].label).toBe('Yes')
    })
})
