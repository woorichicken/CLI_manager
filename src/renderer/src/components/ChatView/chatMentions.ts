import type { ConversationPart, ConversationTurn, ToolPart } from '../../../../shared/conversation'
import { codeIsFilePath, codeIsSessionLink, fileLineTarget, FILE_LINK_COUNT, FILE_LINK_LIMIT, foldUserMessage, resolveChatPath, splitAppAttachments, splitFilePaths, splitSessionLinks, toolFile } from './chatLib'
import { parseMarkdown, type InlineNode, type MarkdownBlock } from './markdown/parseMarkdown'

/**
 * The files a conversation shows as links, as absolute paths — what the phone server takes as «this chat named it»
 * (phone/phoneFiles.ts, decision 0010). The chat's own functions decide, walking the same parts the screen draws
 * (Markdown.tsx, TurnParts.tsx, WorkBlock.tsx), so a link on the phone cannot lead to a refusal, and a path the
 * person never saw as a link is not a way in. Pure, no DOM: main runs it.
 */

/** A target the chat would open: its line suffix off, resolved as `openPath` resolves it (ChatView/index.tsx). */
function addTarget(out: Set<string>, target: string, cwd: string | undefined, home: string | undefined): void {
    const resolved = resolveChatPath(fileLineTarget(target).path, cwd, home)
    if (resolved.startsWith('/')) out.add(resolved)
}

/** LinkedText: session links are taken out first, then the paths in what is left. */
export function addLinkedText(out: Set<string>, text: string, cwd: string | undefined, home: string | undefined): void {
    const pieces = text.includes('climanager://') ? splitSessionLinks(text).filter((part): part is string => typeof part === 'string') : [text]
    for (const piece of pieces) {
        if (piece.length > FILE_LINK_LIMIT) continue
        const paths = splitFilePaths(piece).filter((part): part is { path: string } => typeof part !== 'string')
        if (paths.length > FILE_LINK_COUNT) continue
        for (const part of paths) addTarget(out, part.path, cwd, home)
    }
}

function walkInline(out: Set<string>, nodes: InlineNode[], cwd: string | undefined, home: string | undefined): void {
    for (const node of nodes) {
        switch (node.type) {
            case 'text':
                addLinkedText(out, node.value, cwd, home)
                break
            case 'code':
                if (!codeIsSessionLink(node.value) && codeIsFilePath(node.value)) addTarget(out, node.value, cwd, home)
                break
            case 'image':
                walkInline(out, node.fallback, cwd, home)
                break
            case 'strong':
            case 'em':
            case 'del':
                walkInline(out, node.children, cwd, home)
                break
            case 'file':
                addTarget(out, node.path, cwd, home)
                break
            // a link's label opens that link, and nothing clickable nests in it
            default:
                break
        }
    }
}

function walkBlocks(out: Set<string>, blocks: MarkdownBlock[], cwd: string | undefined, home: string | undefined): void {
    for (const block of blocks) {
        switch (block.type) {
            case 'heading':
                walkInline(out, block.content, cwd, home)
                break
            case 'paragraph':
                for (const line of block.lines) walkInline(out, line, cwd, home)
                break
            case 'list':
                for (const item of block.items) {
                    walkInline(out, item.content, cwd, home)
                    if (item.blocks) walkBlocks(out, item.blocks, cwd, home)
                }
                break
            case 'blockquote':
                walkBlocks(out, block.blocks, cwd, home)
                break
            case 'table':
                for (const cell of block.header) walkInline(out, cell, cwd, home)
                for (const row of block.rows) for (const cell of row) walkInline(out, cell, cwd, home)
                break
            // code and formulas show as text: no links in them
            default:
                break
        }
    }
}

function addMarkdown(out: Set<string>, text: string, cwd: string | undefined, home: string | undefined): void {
    walkBlocks(out, parseMarkdown(text, 0, false), cwd, home)
}

function addTool(out: Set<string>, tool: ToolPart, cwd: string | undefined, home: string | undefined): void {
    let input: Record<string, unknown> = {}
    try {
        const parsed: unknown = JSON.parse(tool.input)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>
    } catch {
        // an input that is not JSON names no file
    }
    const file = toolFile(tool, input)
    if (file) addTarget(out, file, cwd, home)
    if (tool.output) addLinkedText(out, tool.output, cwd, home)
}

function addPart(out: Set<string>, part: ConversationPart, role: ConversationTurn['role'], cwd: string | undefined, home: string | undefined): void {
    switch (part.kind) {
        case 'text':
            if (role === 'assistant') {
                addMarkdown(out, part.text, cwd, home)
                break
            }
            // UserText draws the folded head or the whole text: the limits apply to each on its own
            for (const shown of [part.text, foldUserMessage(part.text)?.head ?? '']) {
                for (const piece of splitAppAttachments(shown)) {
                    if (typeof piece === 'string') addLinkedText(out, piece, cwd, home)
                    else addTarget(out, piece.path, cwd, home)
                }
            }
            break
        case 'tool':
            addTool(out, part, cwd, home)
            break
        case 'notice':
        case 'compact':
            addMarkdown(out, part.text, cwd, home)
            break
        case 'task_result':
            for (const task of part.tasks) if (task.result) addMarkdown(out, task.result, cwd, home)
            break
        // thinking and a shell's output show as plain text
        default:
            break
    }
}

/** Every file the conversation's turns show as a link. */
export function mentionedPaths(turns: ConversationTurn[], cwd: string | undefined, home: string | undefined): Set<string> {
    const out = new Set<string>()
    for (const turn of turns) for (const part of turn.parts) addPart(out, part, turn.role, cwd, home)
    return out
}
