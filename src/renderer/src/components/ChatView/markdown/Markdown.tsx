// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: src/components/Markdown.tsx — Inline, List, CodeBlock, Blocks and Markdown, cut down to what the chat
// draws here. Not ported: KaTeX math and Mermaid/SVG figures (shown as their source / a code block), markdown
// images (shown as their link), skill chips, the web panel, i18n. Links open in the system browser through
// the app's own link handling (target=_blank → shell.openExternal in main). File paths open through the
// chat's actions (ChatActionsContext → the app's file preview), as ovis FilePathLink does.
import { memo, useMemo, useState, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { useChatActions } from '../chatContext'
import { codeIsFilePath, FILE_LINK_COUNT, FILE_LINK_LIMIT, splitFilePaths } from '../chatLib'
import { foldCode, parseMarkdown, type InlineNode, type ListBlock, type MarkdownBlock } from './parseMarkdown'
import { languageForFence } from './highlight'
import { HighlightedCode } from './HighlightedCode'

/** A file path the chat can open: a button that reads as the text or code it replaced. */
export function FilePathLink({ path, code, open }: { path: string; code: boolean; open: (path: string) => void }) {
    return (
        <button type="button" className={`chat-file-link${code ? ' is-code' : ''}`} title={`Open ${path}`} data-testid="chat-file-link" onClick={() => open(path)}>
            {code ? <code>{path}</code> : path}
        </button>
    )
}

/** `text` with the file paths in it as links (`saved to docs/demo.mp4`). Plain where nothing can open one. */
export function LinkedText({ text }: { text: string }) {
    const actions = useChatActions()
    if (!actions?.canOpenPaths || text.length > FILE_LINK_LIMIT) return <>{text}</>
    const parts = splitFilePaths(text)
    if (parts.length === 1 && typeof parts[0] === 'string') return <>{text}</>
    if (parts.filter((part) => typeof part !== 'string').length > FILE_LINK_COUNT) return <>{text}</>
    return (
        <>
            {parts.map((part, index) =>
                typeof part === 'string' ? <span key={index}>{part}</span> : <FilePathLink key={index} path={part.path} code={false} open={actions.openPath} />
            )}
        </>
    )
}

/** `interactive` is false inside a link label: nothing clickable nests in another. */
function Inline({ nodes, interactive = true }: { nodes: InlineNode[]; interactive?: boolean }) {
    const actions = useChatActions()
    return (
        <>
            {nodes.map((node, index) => {
                const key = `${node.type}-${index}`
                switch (node.type) {
                    case 'text':
                        return interactive && actions ? <LinkedText key={key} text={node.value} /> : <span key={key}>{node.value}</span>
                    case 'code':
                        if (interactive && actions?.canOpenPaths && codeIsFilePath(node.value)) {
                            return <FilePathLink key={key} path={node.value} code open={actions.openPath} />
                        }
                        // agents often put an address in backticks: it stays code to the eye, and opens
                        if (interactive && /^https?:\/\/\S+$/i.test(node.value)) {
                            return (
                                <a key={key} className="chat-md-code-link" href={node.value} target="_blank" rel="noopener noreferrer">
                                    <code>{node.value}</code>
                                </a>
                            )
                        }
                        return <code key={key}>{node.value}</code>
                    case 'math':
                        return <span key={key}>{node.dollar ? `$${node.value}$` : `\\(${node.value}\\)`}</span>
                    case 'image':
                        return <Inline key={key} nodes={node.fallback} interactive={interactive} />
                    case 'strong':
                        return (
                            <strong key={key}>
                                <Inline nodes={node.children} interactive={interactive} />
                            </strong>
                        )
                    case 'em':
                        return (
                            <em key={key}>
                                <Inline nodes={node.children} interactive={interactive} />
                            </em>
                        )
                    case 'del':
                        return (
                            <del key={key}>
                                <Inline nodes={node.children} interactive={interactive} />
                            </del>
                        )
                    case 'link':
                        return interactive ? (
                            <a key={key} href={node.href} target="_blank" rel="noopener noreferrer">
                                <Inline nodes={node.children} interactive={false} />
                            </a>
                        ) : (
                            <Inline key={key} nodes={node.children} interactive={false} />
                        )
                    // a link to a local file: the path shows after its words, as Codex's terminal does
                    case 'file':
                        if (interactive && actions?.canOpenPaths) {
                            return (
                                <button key={key} type="button" className="chat-file-link" title={`Open ${node.path}`} data-testid="chat-file-link" onClick={() => actions.openPath(node.path)}>
                                    <Inline nodes={node.children} interactive={false} />
                                </button>
                            )
                        }
                        return (
                            <span key={key}>
                                <Inline nodes={node.children} interactive={false} /> (<code>{node.path}</code>)
                            </span>
                        )
                }
            })}
        </>
    )
}

function List({ block }: { block: ListBlock }) {
    const Tag = block.ordered ? 'ol' : 'ul'
    return (
        <Tag className="chat-md-list" start={block.ordered ? block.start : undefined}>
            {block.items.map((item, index) => (
                <li key={index} className={item.checked === undefined ? undefined : 'chat-md-task'}>
                    {item.checked !== undefined && (
                        <span className="chat-md-task-box" role="checkbox" aria-checked={item.checked} aria-disabled="true">
                            {item.checked && <Check size={10} aria-hidden="true" />}
                        </span>
                    )}
                    <Inline nodes={item.content} />
                    {item.blocks !== undefined && <Blocks blocks={item.blocks} />}
                </li>
            ))}
        </Tag>
    )
}

const COPIED_MS = 1500

function CodeBlock({ language, value }: { language: string; value: string }) {
    const grammar = languageForFence(language)
    const [copied, setCopied] = useState(false)
    const [expanded, setExpanded] = useState(false)
    // no inner scroll: a long block folds, with a visible "Show all" row
    const fold = useMemo(() => foldCode(value), [value])
    const copy = async (): Promise<void> => {
        try {
            await navigator.clipboard.writeText(value)
            setCopied(true)
            window.setTimeout(() => setCopied(false), COPIED_MS)
        } catch {
            setCopied(false)
        }
    }
    return (
        <div className="chat-md-code" data-chat-code={language || 'text'}>
            <div className="chat-md-code-header">
                <span>{language || 'text'}</span>
                <button type="button" className="chat-md-code-copy" onClick={() => void copy()} aria-label={copied ? 'Code copied' : 'Copy code'} title={copied ? 'Copied' : 'Copy code'}>
                    {copied ? <Check size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
                </button>
            </div>
            <HighlightedCode code={fold !== null && !expanded ? fold.head : value} language={grammar} />
            {fold !== null && (
                <button type="button" className="chat-md-code-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
                    {expanded ? 'Show less' : `Show all ${fold.lines} lines`}
                </button>
            )}
        </div>
    )
}

function Blocks({ blocks }: { blocks: MarkdownBlock[] }) {
    return (
        <>
            {blocks.map((block, index): ReactNode => {
                const key = `${block.type}-${index}`
                switch (block.type) {
                    case 'heading':
                        // agent headings are h3 whatever the agent wrote: the app's own headings stay above them
                        return (
                            <h3 key={key} className={`chat-md-h${block.level}`}>
                                <Inline nodes={block.content} />
                            </h3>
                        )
                    case 'paragraph':
                        return (
                            <p key={key}>
                                {block.lines.map((line, lineIndex) => (
                                    <span key={lineIndex}>
                                        <Inline nodes={line} />
                                        {lineIndex < block.lines.length - 1 && <br />}
                                    </span>
                                ))}
                            </p>
                        )
                    case 'list':
                        return <List key={key} block={block} />
                    case 'blockquote':
                        return (
                            <blockquote key={key}>
                                <Blocks blocks={block.blocks} />
                            </blockquote>
                        )
                    case 'code':
                        return <CodeBlock key={key} language={block.language} value={block.value} />
                    case 'math':
                        return <CodeBlock key={key} language="math" value={block.value} />
                    case 'hr':
                        return <hr key={key} />
                    case 'table':
                        return (
                            <div className="chat-md-table-wrap" key={key}>
                                <table>
                                    <thead>
                                        <tr>
                                            {block.header.map((cell, cellIndex) => (
                                                <th key={cellIndex}>
                                                    <Inline nodes={cell} />
                                                </th>
                                            ))}
                                        </tr>
                                    </thead>
                                    <tbody>
                                        {block.rows.map((row, rowIndex) => (
                                            <tr key={rowIndex}>
                                                {row.map((cell, cellIndex) => (
                                                    <td key={cellIndex}>
                                                        <Inline nodes={cell} />
                                                    </td>
                                                ))}
                                            </tr>
                                        ))}
                                    </tbody>
                                </table>
                            </div>
                        )
                }
            })}
        </>
    )
}

/** Markdown rendered. Its props are primitives, so `memo` skips a parent's re-render. */
export const Markdown = memo(function Markdown({ children, className }: { children: string; className?: string }) {
    const blocks = useMemo(() => parseMarkdown(children, 0, false), [children])
    return (
        <div className={className === undefined ? 'chat-md' : `chat-md ${className}`}>
            <Blocks blocks={blocks} />
        </div>
    )
})
