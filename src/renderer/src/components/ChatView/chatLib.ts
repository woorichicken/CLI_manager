// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Sources: src/lib/filePaths.ts (splitFilePaths · codeIsFilePath · fileLineTarget, verbatim), src/lib/diff.ts
// (lineDiff, verbatim), src/lib/userMessageFold.ts (verbatim), src/lib/modelName.ts (modelLabel, verbatim),
// src/lib/todos.ts (todoSnapshot · todoCallSummary for Claude TodoWrite and Codex update_plan only — the
// omp/omo/gjc operation lists are left out). Gathered in one file; the chat's own helpers follow at the end.
import type { ChatCommand, ConversationPart, ToolPart } from '../../../../shared/conversation'
import { SESSION_LINK_REGEX } from '../../utils/sessionLink'

// ---------------------------------------------------------------- file paths (src/lib/filePaths.ts)

/** The terminal's matcher takes the same line, column and range suffixes. */
const LINE_SUFFIX = /(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/
/** what a name is made of: any script's letters, digits and marks */
const NAME = '\\p{L}\\p{N}\\p{M}_'
const ROOT = '(?:~\\/|\\.{1,2}\\/|\\/)'
const EXTENSION = '\\.[A-Za-z0-9]{1,8}'
const LINE = '(?::\\d+(?::\\d+)?|#L\\d+(?:-L?\\d+)?)?'
const SEGMENT = `[${NAME}@.+-]+`
const FILE_NAME = `[${NAME}@+-][${NAME}@.+-]*${EXTENSION}`
const BARE_PATH = new RegExp(`(?<![${NAME}/.@~-])(?<!\\+(?!~))(${ROOT}?(?:${SEGMENT}\\/)+${FILE_NAME}${LINE})(?![\\w/])`, 'gu')
const SPACED = `${SEGMENT}(?: ${SEGMENT})*`
const SPACED_NAME = `[${NAME}@+-](?:[${NAME}@.+-]| (?=[${NAME}@.+-]))*${EXTENSION}`
const CODE_PATH = new RegExp(`^(?:${ROOT}(?:${SPACED}\\/)*${SPACED_NAME}|${SEGMENT}\\/(?:${SPACED}\\/)*${SPACED_NAME}|${FILE_NAME})${LINE}$`, 'u')
const CODE_NAME =
    /^(?:process\.(?:env|argv|cwd|exit|platform|stdout|stderr|stdin)(?:\.\w+)?|Math\.(?:random|floor|ceil|round|max|min|abs|pow|sqrt|trunc|sign)|JSON\.(?:parse|stringify)|console\.(?:log|error|warn|info|debug)|Object\.(?:keys|values|entries|assign|freeze)|Array\.(?:from|isArray)|Promise\.(?:all|race|any|allSettled|resolve|reject)|Number\.(?:isFinite|isInteger|parseInt|parseFloat)|tool\.(?:monitor|read|bash|grep|write|edit)|os\.(?:path|environ|getcwd|getenv)|sys\.(?:argv|path|exit|stdout|stderr)|window\.(?:location|history|open)|document\.(?:body|title|cookie))$/
export function isCodeName(name: string): boolean {
    return !name.includes('/') && CODE_NAME.test(name)
}
const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}'
const SCRIPT_SEAM = new RegExp(`(?<=[${CJK}])(?=[A-Za-z])|(?<=[A-Za-z])(?=[${CJK}])`, 'u')

function* pathMatches(text: string): Generator<{ index: number; 0: string; 1: string }> {
    let start = 0
    for (const run of text.split(SCRIPT_SEAM)) {
        for (const match of run.matchAll(BARE_PATH)) yield { index: start + (match.index ?? 0), 0: match[0], 1: match[1]! }
        start += run.length
    }
}

/** Text split into plain runs and the file paths in it. */
export function splitFilePaths(text: string): (string | { path: string })[] {
    const parts: (string | { path: string })[] = []
    let offset = 0
    for (const match of pathMatches(text)) {
        const index = match.index
        if (!/\p{L}/u.test(match[1]!.replace(LINE_SUFFIX, '').replace(/\.[A-Za-z0-9]{1,8}$/, ''))) continue
        if (index > offset) parts.push(text.slice(offset, index))
        parts.push({ path: match[1]! })
        offset = index + match[0].length
    }
    if (offset < text.length) parts.push(text.slice(offset))
    return parts
}

/** A code span that is a single file name or path (`README.md`, `src/app.ts`). */
export function codeIsFilePath(code: string): boolean {
    const name = code.replace(LINE_SUFFIX, '')
    return (
        CODE_PATH.test(code) &&
        !isCodeName(name) &&
        /\p{L}/u.test(name.replace(/\.[A-Za-z0-9]{1,8}$/, '')) &&
        !/^\d+(?:\.\d+)+$/.test(name) &&
        code.split(' ').filter((word) => CODE_PATH.test(word)).length < 2
    )
}

/** Split a viewer target; columns and range ends are ignored, and only positive safe lines are marked. */
export function fileLineTarget(target: string): { path: string; line: number | null } {
    const suffix = LINE_SUFFIX.exec(target)
    if (suffix === null) return { path: target, line: null }
    const line = Number(suffix[1] ?? suffix[2])
    return { path: target.slice(0, suffix.index), line: Number.isSafeInteger(line) && line >= 1 ? line : null }
}

/** Text past this many characters links no paths (a whole tool output); nor does one with more paths than FILE_LINK_COUNT. */
export const FILE_LINK_LIMIT = 256 * 1024
export const FILE_LINK_COUNT = 500

// ---------------------------------------------------------------- line diff (src/lib/diff.ts)

export interface DiffLine {
    kind: 'same' | 'del' | 'add'
    text: string
}
const MAX_CELLS = 250_000
export function lineDiff(before: string, after: string): DiffLine[] {
    const a = before === '' ? [] : before.split('\n')
    const b = after === '' ? [] : after.split('\n')
    if (a.length * b.length > MAX_CELLS) return [...a.map((text) => ({ kind: 'del' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))]
    const width = b.length + 1
    const lcs = new Uint32Array((a.length + 1) * width)
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
        }
    }
    const lines: DiffLine[] = []
    let i = 0
    let j = 0
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            lines.push({ kind: 'same', text: a[i]! })
            i++
            j++
        } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) lines.push({ kind: 'del', text: a[i++]! })
        else lines.push({ kind: 'add', text: b[j++]! })
    }
    while (i < a.length) lines.push({ kind: 'del', text: a[i++]! })
    while (j < b.length) lines.push({ kind: 'add', text: b[j++]! })
    return lines
}

// ---------------------------------------------------------------- long user messages (src/lib/userMessageFold.ts)

export const USER_MESSAGE_FOLD_LINES = 12
export const USER_MESSAGE_FOLD_CHARS = 900
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\((?:<[^>\n]*>|[^\s)]*)\)/g
export function visibleUserMessageText(text: string): string {
    return text.replace(MARKDOWN_LINK, '$1')
}
export function shouldFoldUserMessage(text: string): boolean {
    const visible = visibleUserMessageText(text).trim()
    if (visible.length === 0) return false
    return visible.length > USER_MESSAGE_FOLD_CHARS || visible.split('\n').length > USER_MESSAGE_FOLD_LINES
}

// ---------------------------------------------------------------- model names (src/lib/modelName.ts)

export interface ModelLabel {
    text: string
    /** false: `text` is the id as received */
    named: boolean
}
const NUMBER = '[1-9]\\d?'
const CLAUDE = new RegExp(`^(?:anthropic/)?claude-(opus|sonnet|haiku|fable|mythos)-(${NUMBER})(?:-(0|${NUMBER}))?$`, 'u')
const GPT = new RegExp(`^gpt-(${NUMBER}(?:\\.${NUMBER})?)(-sol)?$`, 'u')
const GLM = new RegExp(`^glm-(${NUMBER}(?:\\.${NUMBER})?)$`, 'u')
export function modelLabel(id: string): ModelLabel {
    const claude = CLAUDE.exec(id)
    if (claude) {
        const family = claude[1]!
        return { text: `${family.charAt(0).toUpperCase()}${family.slice(1)} ${claude[2]}${claude[3] === undefined ? '' : `.${claude[3]}`}`, named: true }
    }
    const gpt = GPT.exec(id)
    if (gpt) return { text: `GPT-${gpt[1]}${gpt[2] === undefined ? '' : '-Sol'}`, named: true }
    const glm = GLM.exec(id)
    if (glm) return { text: `GLM-${glm[1]}`, named: true }
    return { text: id, named: false }
}

// ---------------------------------------------------------------- todo lists (src/lib/todos.ts)

export type TodoStatus = 'pending' | 'in_progress' | 'completed'
export interface TodoItem {
    label: string
    status: TodoStatus
    /** what the agent says it is doing (Claude's `activeForm`) */
    active?: string
}

const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** Claude Code `TodoWrite` and Codex `update_plan` send the whole list every time. */
export function isTodoTool(name: string): boolean {
    return name === 'TodoWrite' || name === 'update_plan'
}

/** The whole list one todo call leaves, or null when it cannot be read. */
export function todoSnapshot(part: ToolPart): TodoItem[] | null {
    if (!isTodoTool(part.name)) return null
    let input: unknown
    try {
        input = JSON.parse(part.input)
    } catch {
        return null
    }
    const whole = part.name === 'TodoWrite'
    const list = record(input)[whole ? 'todos' : 'plan']
    if (!Array.isArray(list)) return null
    const items: TodoItem[] = []
    for (const entry of list) {
        const fields = record(entry)
        const label = text(fields[whole ? 'content' : 'step'])
        if (label === null) return null
        const status = fields['status']
        const active = text(fields['activeForm'])
        items.push({
            label,
            status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
            ...(active ? { active } : {})
        })
    }
    return items
}

// ---------------------------------------------------------------- the chat's own helpers

/** `3/7 done` for a list. */
export function todoProgress(items: TodoItem[]): { done: number; total: number; current: TodoItem | null } {
    return {
        done: items.filter((item) => item.status === 'completed').length,
        total: items.length,
        current: items.find((item) => item.status === 'in_progress') ?? null
    }
}

/** The list the newest todo call in these turns left. */
export function latestTodos(turns: { parts: ConversationPart[] }[]): TodoItem[] | null {
    for (let t = turns.length - 1; t >= 0; t--) {
        const parts = turns[t].parts
        for (let p = parts.length - 1; p >= 0; p--) {
            const part = parts[p]
            if (part.kind !== 'tool' || !isTodoTool(part.name)) continue
            const items = todoSnapshot(part)
            if (items) return items
        }
    }
    return null
}

/** Pages the agent published with Claude's Artifact tool, newest first: their claude.ai address and a title. */
export function artifactLinks(turns: { parts: ConversationPart[] }[]): { url: string; title: string }[] {
    const found = new Map<string, string>()
    for (let t = turns.length - 1; t >= 0; t--) {
        for (const part of turns[t].parts) {
            if (part.kind !== 'tool' || part.name !== 'Artifact' || part.error) continue
            const url = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/.exec(part.output)?.[0]
            if (!url || found.has(url)) continue
            let title = ''
            try {
                const input = record(JSON.parse(part.input))
                title = text(input.title) ?? text(input.file_path)?.split('/').pop() ?? ''
            } catch {
                title = ''
            }
            found.set(url, title || url)
        }
    }
    return [...found].map(([url, title]) => ({ url, title }))
}

/** `12s`, `3m 05s`, `1h 02m` — how long a turn has been working. */
export function formatElapsed(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** `84k`, `1.2M` tokens. */
export function formatTokens(count: number): string {
    if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`
    if (count >= 1000) return `${Math.round(count / 1000)}k`
    return String(count)
}

/** An absolute path for one the chat names: `~/` and relative paths resolve against home and the session's folder. */
export function resolveChatPath(path: string, cwd: string | undefined, home?: string): string {
    if (path.startsWith('/')) return path
    if (path.startsWith('~/') && home) return `${home.replace(/\/$/, '')}/${path.slice(2)}`
    if (!cwd) return path
    const parts = `${cwd.replace(/\/$/, '')}/${path}`.split('/')
    const out: string[] = []
    for (const part of parts) {
        if (part === '..') out.pop()
        else if (part !== '.' && part !== '') out.push(part)
    }
    return `/${out.join('/')}`
}

/** The person's message as typed: a `/command` or `! shell` never comes back as a user bubble. */
export function isCommandText(text: string): boolean {
    return /^\s*[/!]/.test(text)
}

/** Claude Code's marker of a turn the person stopped. */
export const INTERRUPTED_TEXT = /^\[Request interrupted by user(?: for tool use)?\]$/

/**
 * What the composer's menu is completing: a `/command` (or Codex `$skill`) at a line's start, a skill after
 * a space mid-line (`inline` — c21d4b5a · 574c78e4), or an `@file`.
 */
export type Trigger = { kind: 'slash'; prefix: '/' | '$'; query: string; start: number; inline?: boolean } | { kind: 'file'; query: string; start: number }

export function activeTrigger(text: string, caret: number, codex: boolean): Trigger | null {
    const before = text.slice(0, caret)
    const slash = /(?:^|\n)([/$])([\w:.-]*)$/.exec(before)
    if (slash && (slash[1] === '/' || codex)) {
        return { kind: 'slash', prefix: slash[1] as '/' | '$', query: slash[2], start: caret - slash[2].length - 1 }
    }
    // After other words a skill still runs — Claude Code reads `… /climanager …` anywhere in a message, and
    // Codex a `$skill` mention. A path (`src/a`, `~/x`) is not after a space, so it never opens the menu.
    const inline = /[ \t]([/$])([\w:.-]*)$/.exec(before)
    if (inline && (inline[1] === '/' ? !codex : codex)) {
        return { kind: 'slash', prefix: inline[1] as '/' | '$', query: inline[2], start: caret - inline[2].length - 1, inline: true }
    }
    const file = /(?:^|\s)@([^\s@"]*)$/.exec(before)
    if (file) return { kind: 'file', query: file[1], start: caret - file[1].length - 1 }
    return null
}

/** `@path`, quoted when the path holds a space (the mention ends at a space otherwise). */
export function fileMention(path: string): string {
    return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

// moved to shared (main also needs it for queued sends, F18)
export { terminalCommand } from '../../../../shared/conversation'

/** A file the chat's ＋ / paste / drop stored for a message (main chatAttachments.ts: `<tmp>/climanager-chat/<day>/<name>`). */
export interface AppAttachmentMention {
    path: string
    /** the stored name's extension, lower case, without the dot ('' when none) */
    extension: string
    image: boolean
}

const APP_ATTACHMENT = /(^|\s)@(\/\S*\/climanager-chat\/\S+)/g
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'bmp', 'tif', 'tiff'])

/**
 * A sent message with the app's own attachment mentions (`@/var/folders/…/climanager-chat/2026-11-04/1793…-75f5.png`)
 * taken out: the person attached a file, they never typed that path — the bubble shows a chip for it (G7).
 * Other `@` mentions (a file the person named) stay text.
 */
export function splitAppAttachments(text: string): (string | AppAttachmentMention)[] {
    const out: (string | AppAttachmentMention)[] = []
    let last = 0
    for (const match of text.matchAll(APP_ATTACHMENT)) {
        const start = (match.index ?? 0) + match[1].length
        if (start > last) out.push(text.slice(last, start))
        const path = match[2]
        const name = path.slice(path.lastIndexOf('/') + 1)
        const dot = name.lastIndexOf('.')
        const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
        out.push({ path, extension, image: IMAGE_EXTENSIONS.has(extension) })
        last = start + 1 + path.length
    }
    if (last < text.length) out.push(text.slice(last))
    // the space that followed a chip is not part of the words
    return out.map((part, index) => (typeof part === 'string' && index > 0 && typeof out[index - 1] !== 'string' ? part.replace(/^\s+/, '') : part)).filter((part) => part !== '')
}

/** Rows the completion menu lists at most. */
const MENU_ROWS = 40

/** Picked in this chat (`usage`, per browser) plus run by the agent itself (`uses`, Claude's own count). */
function uses(command: ChatCommand, usage: Record<string, number>): number {
    return (usage[command.name] ?? 0) + (command.uses ?? 0)
}

/** The `/` menu: best match first, then the most used, user's own before built-ins, then by name. */
export function rankCommands(commands: ChatCommand[], trigger: Extract<Trigger, { kind: 'slash' }>, usage: Record<string, number>): ChatCommand[] {
    const query = trigger.query.toLowerCase()
    const wanted = commands.filter(
        (command) =>
            (trigger.prefix === '$' ? command.trigger === '$' : command.trigger !== '$') &&
            // mid-message only a skill or the person's own command runs; `/model` there is just words
            !(trigger.inline && command.source === 'builtin')
    )
    const scored = wanted
        .map((command) => {
            const name = command.name.toLowerCase()
            const score = query === '' ? 1 : name.startsWith(query) ? 3 : name.split(/[:-]/).some((word) => word.startsWith(query)) ? 2 : name.includes(query) ? 1 : 0
            return { command, score }
        })
        .filter(({ score }) => score > 0)
    scored.sort(
        (a, b) =>
            b.score - a.score ||
            uses(b.command, usage) - uses(a.command, usage) ||
            Number(a.command.source === 'builtin') - Number(b.command.source === 'builtin') ||
            a.command.name.localeCompare(b.command.name)
    )
    return scored.slice(0, MENU_ROWS).map(({ command }) => command)
}

/** `text` with its `climanager://session/…` links cut out, in order (b2020233) — the terminal's matcher. */
export function splitSessionLinks(text: string): (string | { sessionLink: string })[] {
    const pattern = new RegExp(SESSION_LINK_REGEX.source, 'g')
    const out: (string | { sessionLink: string })[] = []
    let last = 0
    for (const match of text.matchAll(pattern)) {
        const start = match.index ?? 0
        if (start > last) out.push(text.slice(last, start))
        out.push({ sessionLink: match[0] })
        last = start + match[0].length
    }
    if (last < text.length) out.push(text.slice(last))
    return out
}

/** A whole inline code span that is one session link (`climanager://session/be5c9a25`). */
export function codeIsSessionLink(code: string): boolean {
    const parts = splitSessionLinks(code.trim())
    return parts.length === 1 && typeof parts[0] !== 'string'
}
