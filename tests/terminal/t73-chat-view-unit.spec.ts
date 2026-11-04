import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseClaudeTranscript } from '../../src/main/transcript/claudeTranscript'
import { parseCodexTranscript } from '../../src/main/transcript/codexTranscript'
import { TranscriptReader, claudeProjectSlug } from '../../src/main/TranscriptReader'
import { answerSteps, KEYS, readPrompt } from '../../src/main/promptScreen'
import type { ConversationPart, ConversationTurn, ToolPart } from '../../src/shared/conversation'
import { foldMetadata } from '../../src/main/transcript/metadata'
import { DEFAULT_SHORTCUTS, effectiveShortcuts } from '../../src/shared/types'
import { ConversationService, type ConversationServiceDeps } from '../../src/main/ConversationService'
import { createChatCommandLister } from '../../src/main/chatCommands'
import { saveChatAttachment } from '../../src/main/chatAttachments'
import { activeTrigger,
    artifactLinks,
    codeIsFilePath,
    fileLineTarget,
    fileMention,
    latestTodos,
    lineDiff,
    modelLabel,
    resolveChatPath,
    shouldFoldUserMessage,
    splitFilePaths,
    terminalCommand,
    todoSnapshot, splitAppAttachments } from '../../src/renderer/src/components/ChatView/chatLib'

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
        const summary = records(claudeFile("compacted.jsonl")).find((e) => e.isCompactSummary)!.message.content
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
        const queued = records(claudeFile('queued.jsonl')).find((e) => e.type === 'attachment')!.attachment.prompt
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
        // no dialog edge above it: the agent's output above is not the question's context
        expect(readPrompt(['ANSWER[2]: ASK', 'Do you trust the contents of this directory?', '› 1. Yes, continue', '  2. No, quit', 'Press enter to continue'], 'codex')!.context).toEqual([])
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

// ------------------------------------------------------------------------------------------------
// 2nd round (ovis gap): model · effort · context, records read back (pictures, cut outputs), stop,
// queued messages one by one, the `/` command list, attachments, and the composer's pure helpers.
// Expected values come out of the records written here, never typed twice.
// ------------------------------------------------------------------------------------------------

const jsonl = (entries: unknown[]): string => entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n'

test.describe('T73 r2 model, effort and context from the records (ported ovis conversation-metadata)', () => {
    test('Claude: the answer names model, effort and usage; a /model answer sets the next model; /clear forgets', () => {
        const usage = { input_tokens: 3, cache_creation_input_tokens: 700, cache_read_input_tokens: 41_000, output_tokens: 90 }
        const answer = { type: 'assistant', uuid: 'a1', effort: 'xhigh', message: { role: 'assistant', model: 'claude-opus-5-5', usage, content: [{ type: 'text', text: 'hi' }] } }
        const sidechain = { ...answer, uuid: 'a2', isSidechain: true, message: { ...answer.message, usage: { input_tokens: 999_999 } } }
        let meta = foldMetadata(jsonl([answer, sidechain]), 'claude', null)
        expect(meta).toEqual({ model: answer.message.model, effort: answer.effort, context: { used: usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens, window: null } })
        const said = 'Set model to `Sonnet 5`'
        meta = foldMetadata(jsonl([{ type: 'user', uuid: 'c1', message: { role: 'user', content: `<local-command-stdout>${said}</local-command-stdout>` } }]), 'claude', meta)
        expect(meta?.model).toBe('claude-sonnet-5')
        meta = foldMetadata(jsonl([{ type: 'user', uuid: 'c2', message: { role: 'user', content: '<command-name>/clear</command-name>' } }]), 'claude', meta)
        expect(meta).toEqual({ model: null, effort: null })
    })

    test('Codex: turn_context names model and effort; token_count fills the context against its window', () => {
        const context = { type: 'turn_context', payload: { model: 'gpt-6-luna', effort: 'medium' } }
        const tokens = { type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: 48_011 }, model_context_window: 828_400 } } }
        expect(foldMetadata(jsonl([context, tokens]), 'codex', null)).toEqual({
            model: context.payload.model,
            effort: context.payload.effort,
            context: { used: tokens.payload.info.last_token_usage.total_tokens, window: tokens.payload.info.model_context_window }
        })
    })

    test('the reader carries the meta of the lines it read', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't73-meta-'))
        const id = '00000000-0000-4000-8000-00000000aa01'
        const file = path.join(dir, 'projects', claudeProjectSlug('/w'), `${id}.jsonl`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        const answer = { type: 'assistant', uuid: 'm1', timestamp: '2026-11-03T01:00:00.000Z', effort: 'high', message: { role: 'assistant', model: 'claude-haiku-4-5', stop_reason: 'end_turn', usage: { input_tokens: 10 }, content: [{ type: 'text', text: 'ok' }] } }
        fs.writeFileSync(file, jsonl([{ type: 'user', uuid: 'u1', timestamp: '2026-11-03T01:00:00.000Z', message: { role: 'user', content: 'q' } }, answer]))
        const reader = new TranscriptReader({ claudeConfigDir: () => dir, codexHome: () => dir })
        expect(reader.read('s', 'claude', id, '/w')?.meta).toEqual({ model: answer.message.model, effort: answer.effort, context: { used: 10, window: null } })
    })
})

test.describe('T73 r2 records read back from the transcript (pictures, a cut output)', () => {
    test('a pasted picture is read back by its ref, across chunk edges; an unknown ref is null', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't73-image-'))
        const id = '00000000-0000-4000-8000-00000000aa02'
        const file = path.join(dir, 'projects', claudeProjectSlug('/w'), `${id}.jsonl`)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.copyFileSync(claudeFile('image.jsonl'), file)
        const reader = new TranscriptReader({ claudeConfigDir: () => dir, codexHome: () => dir, findChunkBytes: 64 })
        const turns = reader.read('s', 'claude', id, '/w')!.turns
        const image = turns[0].parts.find((part) => part.kind === 'image') as { ref: string; media_type: string }
        const block = records(claudeFile('image.jsonl'))[0].message.content[0].source
        expect(await reader.image('s', image.ref)).toBe(`data:${block.media_type};base64,${block.data}`)
        expect(await reader.image('s', `${image.ref.split(':')[0]}:9`)).toBeNull()
        expect(await reader.image('s', 'not-a-ref')).toBeNull()
    })

    test('a tool output cut in the chat is read back whole (Claude tool_use_id, Codex call_id)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't73-output-'))
        const whole = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
        const id = '00000000-0000-4000-8000-00000000aa03'
        const claudeFilePath = path.join(dir, 'projects', claudeProjectSlug('/w'), `${id}.jsonl`)
        fs.mkdirSync(path.dirname(claudeFilePath), { recursive: true })
        fs.writeFileSync(claudeFilePath, jsonl([
            { type: 'user', uuid: 'u1', timestamp: '2026-11-03T01:00:00.000Z', message: { role: 'user', content: 'run it' } },
            { type: 'assistant', uuid: 'a1', timestamp: '2026-11-03T01:00:01.000Z', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'toolu_long', name: 'Bash', input: { command: 'seq' } }] } },
            { type: 'user', uuid: 'r1', timestamp: '2026-11-03T01:00:02.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_long', content: whole }] } },
            { type: 'assistant', uuid: 'a2', timestamp: '2026-11-03T01:00:03.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }
        ]))
        const reader = new TranscriptReader({ claudeConfigDir: () => dir, codexHome: () => dir, findChunkBytes: 100 })
        const tool = reader.read('c', 'claude', id, '/w')!.turns[1].parts.find((part) => part.kind === 'tool') as ToolPart
        expect(tool.output_size).toBe(whole.length)
        expect(tool.output.length).toBeLessThan(whole.length)
        expect(await reader.toolOutput('c', tool.output_ref!)).toBe(whole)

        const codexId = '00000000-0000-4000-8000-00000000aa04'
        const rollout = path.join(dir, 'sessions', '2026', '11', '03', `rollout-2026-11-03T01-00-00-${codexId}.jsonl`)
        fs.mkdirSync(path.dirname(rollout), { recursive: true })
        fs.writeFileSync(rollout, jsonl([
            { timestamp: '2026-11-03T01:00:00.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'run it' } },
            { timestamp: '2026-11-03T01:00:01.000Z', type: 'response_item', payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"seq"}', call_id: 'call_long' } },
            { timestamp: '2026-11-03T01:00:02.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_long', output: whole } }
        ]))
        const codexTool = reader.read('x', 'codex', codexId)!.turns.flatMap((turn) => turn.parts).find((part) => part.kind === 'tool') as ToolPart
        expect(codexTool.output_size).toBe(whole.length)
        expect(await reader.toolOutput('x', codexTool.output_ref!)).toBe(whole)
    })
})

test.describe('T73 r2 ConversationService: stop, queued messages one by one, commands', () => {
    function service(screen: string[], typed = '') {
        const writes: string[] = []
        const sent: string[] = []
        const deps: ConversationServiceDeps = {
            session: () => ({ cwd: '/w', cliSessionId: undefined, cliToolName: 'claude' }),
            reader: new TranscriptReader({ claudeConfigDir: () => '/nonexistent', codexHome: () => '/nonexistent' }),
            mirror: {
                screen: () => screen,
                flush: async () => undefined,
                lastOutputAt: () => Date.now(),
                hasExited: () => false,
                showsAwaitingInput: () => false,
                inputBox: () => ({ typed })
            },
            hasTerminal: () => true,
            writeInput: (_id, data) => writes.push(data),
            type: async (_id, text) => (sent.push(text), true),
            onChange: () => undefined,
            listCommands: (agent) => [{ name: agent === 'claude' ? 'config' : 'model', description: '', source: 'builtin', terminal: 'always' }]
        }
        return { conversations: new ConversationService(deps), writes, sent }
    }
    const WORKING = ['✻ Working… (esc to interrupt)', '─'.repeat(20), '❯ ', '─'.repeat(20)]
    const IDLE = ['─'.repeat(20), '❯ ', '─'.repeat(20)]

    test('Stop sends Esc only while the screen shows a turn in progress', async () => {
        const idle = service(IDLE)
        expect(await idle.conversations.interrupt('s')).toMatchObject({ status: 'rejected', reason: 'not_working' })
        expect(idle.writes).toEqual([])
        const busy = service(WORKING)
        expect(await busy.conversations.interrupt('s')).toEqual({ status: 'stopped' })
        expect(busy.writes).toEqual(['\x1b'])
    })

    test('queued while working, each with an id: Send now types one, ✕ drops one, the rest stay in order', async () => {
        const { conversations, sent } = service(WORKING)
        conversations.subscribe('s')
        for (const text of ['one', 'two', 'three']) expect(await conversations.send('s', text)).toEqual({ status: 'queued' })
        let queued = (await conversations.getConversation('s')).queued
        expect(queued.map((item) => item.text)).toEqual(['one', 'two', 'three'])
        expect(new Set(queued.map((item) => item.id)).size).toBe(3)
        expect(await conversations.sendQueuedNow('s', queued[1].id)).toEqual({ status: 'sent' })
        expect(sent).toEqual(['two'])
        expect(conversations.discardQueued('s', queued[0].id)).toBe(true)
        // the receipt Edit waits for (F19): gone already — sent now, or withdrawn — is false
        expect(conversations.discardQueued('s', queued[0].id)).toBe(false)
        expect(conversations.discardQueued('s', queued[1].id)).toBe(false)
        queued = (await conversations.getConversation('s')).queued
        expect(queued.map((item) => item.text)).toEqual(['three'])
        conversations.unsubscribe('s')
        conversations.cancelQueued('s')
    })

    test('Send now is refused while the terminal input line holds text, and the message stays queued', async () => {
        const { conversations, sent } = service(WORKING, 'half typed')
        conversations.subscribe('s')
        // a send is refused for the same reason, so queue it while the box is empty first
        ;(conversations as unknown as { entry(id: string): { queue: { id: string; text: string }[] } }).entry('s').queue.push({ id: 'q-test', text: 'later' })
        expect(await conversations.sendQueuedNow('s', 'q-test')).toMatchObject({ status: 'rejected', reason: 'input_busy' })
        expect(sent).toEqual([])
        expect((await conversations.getConversation('s')).queued.map((item) => item.id)).toEqual(['q-test'])
        conversations.unsubscribe('s')
        conversations.cancelQueued('s')
    })

    test('the command list comes from the lister for the session’s agent', () => {
        expect(service(IDLE).conversations.listCommands('s').map((command) => command.name)).toEqual(['config'])
    })
})

test.describe('T73 r2 `/` commands an agent offers (ported ovis command tables)', () => {
    test('Claude: personal and project skills, command files, and built-ins marked terminal-only', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 't73-cmds-'))
        const config = path.join(home, '.claude')
        const project = path.join(home, 'project')
        fs.mkdirSync(path.join(config, 'skills', 'my-skill'), { recursive: true })
        fs.writeFileSync(path.join(config, 'skills', 'my-skill', 'SKILL.md'), '---\nname: my-skill\ndescription: Does a thing\n---\nbody')
        fs.mkdirSync(path.join(config, 'skills', 'hidden'), { recursive: true })
        fs.writeFileSync(path.join(config, 'skills', 'hidden', 'SKILL.md'), '---\nname: hidden\nuser-invocable: false\n---\n')
        fs.mkdirSync(path.join(config, 'commands', 'team'), { recursive: true })
        fs.writeFileSync(path.join(config, 'commands', 'team', 'standup.md'), '---\ndescription: Standup notes\n---\n')
        fs.mkdirSync(path.join(project, '.git'), { recursive: true })
        fs.mkdirSync(path.join(project, '.claude', 'skills', 'local-one'), { recursive: true })
        fs.writeFileSync(path.join(project, '.claude', 'skills', 'local-one', 'SKILL.md'), '---\ndescription: Project skill\n---\n')
        const list = createChatCommandLister({ home, claudeConfigDir: () => config, codexHome: () => path.join(home, '.codex') })('claude', project)
        const byName = new Map(list.map((command) => [command.name, command]))
        expect(byName.get('my-skill')).toMatchObject({ source: 'skill', description: 'Does a thing' })
        expect(byName.has('hidden')).toBe(false)
        expect(byName.get('team:standup')).toMatchObject({ source: 'command', description: 'Standup notes' })
        expect(byName.get('local-one')).toMatchObject({ source: 'project' })
        expect(byName.get('config')).toMatchObject({ source: 'builtin', terminal: 'always' })
        expect(byName.get('model')).toMatchObject({ source: 'builtin', terminal: 'bare' })
        expect(byName.get('compact')?.terminal).toBeUndefined()
        // what the chat does after sending them
        expect(terminalCommand('/config', list)).toBe('/config')
        expect(terminalCommand('/model', list)).toBe('/model')
        expect(terminalCommand('/model sonnet', list)).toBeNull()
        expect(terminalCommand('/compact', list)).toBeNull()
        expect(terminalCommand('please /config', list)).toBeNull()
    })

    test('Codex: built-ins, and skills typed with $', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 't73-codex-cmds-'))
        const codex = path.join(home, '.codex')
        fs.mkdirSync(path.join(codex, 'skills', 'deep', 'nested-skill'), { recursive: true })
        fs.writeFileSync(path.join(codex, 'skills', 'deep', 'nested-skill', 'SKILL.md'), '---\nname: nested-skill\ndescription: Codex skill\n---\n')
        const list = createChatCommandLister({ home, claudeConfigDir: () => path.join(home, '.claude'), codexHome: () => codex })('codex', undefined)
        expect(list.find((command) => command.name === 'nested-skill')).toMatchObject({ trigger: '$', source: 'skill' })
        expect(list.find((command) => command.name === 'model')).toMatchObject({ terminal: 'bare' })
        expect(list.find((command) => command.name === 'status')).toMatchObject({ terminal: 'always' })
    })

    test('Codex: 300 skills with scripts/references folders are all listed', () => {
        const home = fs.mkdtempSync(path.join(os.tmpdir(), 't73-codex-many-'))
        const codex = path.join(home, '.codex')
        const SKILL_COUNT = 300
        for (let i = 0; i < SKILL_COUNT; i++) {
            const folder = path.join(codex, 'skills', `skill-${String(i).padStart(3, '0')}`)
            for (const sub of ['scripts', 'references', 'assets']) fs.mkdirSync(path.join(folder, sub), { recursive: true })
            fs.writeFileSync(path.join(folder, 'SKILL.md'), `---\nname: skill-${i}\ndescription: d\n---\n`)
        }
        const list = createChatCommandLister({ home, claudeConfigDir: () => path.join(home, '.claude'), codexHome: () => codex })('codex', undefined)
        expect(list.filter((command) => command.trigger === '$')).toHaveLength(SKILL_COUNT)
    })
})

test.describe('T73 r2 attachments and the composer helpers', () => {
    test('a pasted picture is stored under an ASCII name with its type; too large is refused', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 't73-attach-'))
        const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
        const name = '스크린샷 2026.png'.normalize('NFD')
        const saved = saveChatAttachment(root, name, new Uint8Array(bytes))
        expect(saved.status).toBe('attached')
        const file = (saved as { path: string }).path
        expect(path.basename(file)).toMatch(/^\d+-[0-9a-f]{8}\.png$/)
        expect(fs.readFileSync(file).equals(bytes)).toBe(true)
        expect(saveChatAttachment(root, 'big.bin', new Uint8Array(32 * 1024 * 1024 + 1))).toMatchObject({ status: 'rejected', reason: 'too_large' })
    })

    test('completion triggers, mentions, paths, diffs, folds, model names, plans', () => {
        expect(activeTrigger('/rev', 4, false)).toEqual({ kind: 'slash', prefix: '/', query: 'rev', start: 0 })
        expect(activeTrigger('hello\n/co', 9, false)).toMatchObject({ kind: 'slash', query: 'co', start: 6 })
        expect(activeTrigger('a/b', 3, false)).toBeNull()
        expect(activeTrigger('$sk', 3, false)).toBeNull()
        expect(activeTrigger('$sk', 3, true)).toMatchObject({ kind: 'slash', prefix: '$', query: 'sk' })
        expect(activeTrigger('look at @src/ma', 15, false)).toEqual({ kind: 'file', query: 'src/ma', start: 8 })
        expect(activeTrigger('mail a@b', 8, false)).toBeNull()
        expect(fileMention('/tmp/a.png')).toBe('@/tmp/a.png')
        expect(fileMention('/w/x/My Docs/a.png')).toBe('@"/w/x/My Docs/a.png"')

        expect(splitFilePaths('saved to docs/demo.mp4 and src/a.ts:12.')).toEqual(['saved to ', { path: 'docs/demo.mp4' }, ' and ', { path: 'src/a.ts:12' }, '.'])
        expect(splitFilePaths('and/or e.g. 1.2.3')).toEqual(['and/or e.g. 1.2.3'])
        expect(codeIsFilePath('README.md')).toBe(true)
        expect(codeIsFilePath('process.env')).toBe(false)
        expect(fileLineTarget('src/a.ts#L40')).toEqual({ path: 'src/a.ts', line: 40 })
        expect(resolveChatPath('src/../lib/a.ts', '/w/app')).toBe('/w/app/lib/a.ts')
        expect(resolveChatPath('~/x.md', '/w', '/h/me')).toBe('/h/me/x.md')
        expect(resolveChatPath('/abs/x', '/w')).toBe('/abs/x')

        const before = 'a\nb\nc'
        const after = 'a\nB\nc\nd'
        const diff = lineDiff(before, after)
        expect(diff.filter((line) => line.kind !== 'add').map((line) => line.text)).toEqual(before.split('\n'))
        expect(diff.filter((line) => line.kind !== 'del').map((line) => line.text)).toEqual(after.split('\n'))

        expect(shouldFoldUserMessage('short')).toBe(false)
        expect(shouldFoldUserMessage(Array.from({ length: 13 }, (_, i) => `l${i}`).join('\n'))).toBe(true)
        expect(modelLabel('claude-opus-5-5')).toEqual({ text: 'Opus 5.5', named: true })
        expect(modelLabel('gpt-6-luna')).toEqual({ text: 'gpt-6-luna', named: false })

        const todos = [{ content: 'A', status: 'completed', activeForm: 'Doing A' }, { content: 'B', status: 'in_progress', activeForm: 'Doing B' }]
        const tool: ToolPart = { kind: 'tool', name: 'TodoWrite', summary: '', input: JSON.stringify({ todos }), output: '' }
        expect(todoSnapshot(tool)).toEqual(todos.map((todo) => ({ label: todo.content, status: todo.status, active: todo.activeForm })))
        expect(latestTodos([{ parts: [tool] }])?.length).toBe(2)
        const codexPlan: ToolPart = { kind: 'tool', name: 'update_plan', summary: '', input: JSON.stringify({ plan: [{ step: 'X', status: 'pending' }] }), output: '' }
        expect(todoSnapshot(codexPlan)).toEqual([{ label: 'X', status: 'pending' }])
        const artifact: ToolPart = { kind: 'tool', name: 'Artifact', summary: '', input: JSON.stringify({ title: 'Report' }), output: 'Published https://claude.ai/code/artifact/abc-123 ok' }
        expect(artifactLinks([{ parts: [artifact] }])).toEqual([{ url: 'https://claude.ai/code/artifact/abc-123', title: 'Report' }])
    })
})

test.describe('T73 r2 shortcut defaults never take a chord the person already bound', () => {
    test('a stored binding on ⌘⇧M keeps it; the new Terminal / Chat default is left unbound, the rest stay', () => {
        const mine = { key: 'M', modifiers: ['mod', 'shift'] as ('mod' | 'shift' | 'alt')[], code: 'm' }
        expect(DEFAULT_SHORTCUTS.toggleChatView).toMatchObject({ code: mine.code, modifiers: mine.modifiers })
        const effective = effectiveShortcuts({ memoNewPage: mine })
        expect(effective.memoNewPage).toEqual(mine)
        expect(effective.toggleChatView.code).toBe('')
        expect(effective.focusChatInput).toEqual(DEFAULT_SHORTCUTS.focusChatInput)
        expect(effectiveShortcuts(undefined)).toEqual(DEFAULT_SHORTCUTS)
        // an explicit choice for the chat itself is kept even when it equals another stored one's
        expect(effectiveShortcuts({ toggleChatView: mine, memoNewPage: mine }).toggleChatView).toEqual(mine)
    })
})


test('T73 app attachment mentions (G7): the chat\'s own stored files become chips, a typed @path stays text', () => {
    const path = '/var/folders/ab/c0d1e2f3/T/climanager-chat/2026-11-04/1793809848410-75f57aee.png'
    expect(splitAppAttachments(`@${path}  What text is in the attached image? Answer in three words.`)).toEqual([
        { path, extension: 'png', image: true },
        'What text is in the attached image? Answer in three words.'
    ])
    const doc = '/tmp/climanager-chat/2026-11-05/1-ab.pdf'
    expect(splitAppAttachments(`see @${path} and @${doc}`)).toEqual(['see ', { path, extension: 'png', image: true }, 'and ', { path: doc, extension: 'pdf', image: false }])
    // a file the person named, an e-mail, no attachment: unchanged
    expect(splitAppAttachments('look at @src/main/index.ts please')).toEqual(['look at @src/main/index.ts please'])
    expect(splitAppAttachments('mail kim@climanager-chat.dev')).toEqual(['mail kim@climanager-chat.dev'])
})
