import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { DocPreviewOpenResult } from '../../../../shared/docPreview'
import { DOC_PREVIEW_MESSAGE, DOC_PREVIEW_SANDBOX, docPreviewSibling } from '../../../../shared/docPreview'

/**
 * An HTML report, drawn or as its source — the preview window's body (A) and a split pane's (B).
 *
 * Drawn: a sandboxed frame on `climanager-doc:` (decision 0013). The page gets an opaque origin, so it cannot reach
 * `window.api`; its policy refuses every connection. Its only word to us is Escape (the bridge in main/docPreview.ts).
 * Source: the text preview's reader, so its 500 KB limit applies there — drawing has the phone's 64 MB.
 */
interface HtmlDocViewProps {
    path: string
    line?: number
    source: boolean
    onEscape?: () => void
    /** a link to another page of the folder: the owner shows that path instead */
    onNavigate?: (path: string) => void
    /** the page took the focus (a click inside it): clicks in a frame never reach this document */
    onFrameFocus?: () => void
}

export function HtmlDocView({ path, line, source, onEscape, onNavigate, onFrameFocus }: HtmlDocViewProps) {
    return source ? <HtmlSource path={path} line={line} /> : <HtmlFrame path={path} onEscape={onEscape} onNavigate={onNavigate} onFrameFocus={onFrameFocus} />
}

function HtmlFrame({ path, onEscape, onNavigate, onFrameFocus }: Pick<HtmlDocViewProps, 'path' | 'onEscape' | 'onNavigate' | 'onFrameFocus'>) {
    const [opened, setOpened] = useState<DocPreviewOpenResult | null>(null)
    const frameRef = useRef<HTMLIFrameElement>(null)
    const handlers = useRef({ onEscape, onNavigate, onFrameFocus, path })
    handlers.current = { onEscape, onNavigate, onFrameFocus, path }

    useEffect(() => {
        let live = true
        setOpened(null)
        window.api.openDocPreview(path).then(
            (result) => live && setOpened(result),
            (error: unknown) => live && setOpened({ status: 'refused', reason: 'not_found', message: error instanceof Error ? error.message : String(error) })
        )
        return () => {
            live = false
        }
    }, [path])

    useEffect(() => {
        const onMessage = (event: MessageEvent): void => {
            // only this frame's own page, and only the one thing it may say
            if (event.source !== frameRef.current?.contentWindow) return
            const data = event.data as { type?: unknown; key?: unknown; open?: unknown; pressed?: unknown } | null
            if (data?.type !== DOC_PREVIEW_MESSAGE) return
            if (data.key === 'Escape') handlers.current.onEscape?.()
            if (data.pressed === true) handlers.current.onFrameFocus?.()
            const sibling = docPreviewSibling(handlers.current.path, data.open)
            if (sibling && handlers.current.onNavigate) handlers.current.onNavigate(sibling)
        }
        // focus moving into the frame blurs this window; the frame is then the active element
        const onBlur = (): void => {
            setTimeout(() => {
                if (frameRef.current && document.activeElement === frameRef.current) handlers.current.onFrameFocus?.()
            }, 0)
        }
        window.addEventListener('message', onMessage)
        window.addEventListener('blur', onBlur)
        return () => {
            window.removeEventListener('message', onMessage)
            window.removeEventListener('blur', onBlur)
        }
    }, [])

    if (!opened) return <Centered><Loader2 size={20} className="text-blue-400 animate-spin" /></Centered>
    if (opened.status !== 'ok') {
        return (
            <Centered>
                <div className="flex items-center gap-2 text-red-400 text-sm" data-testid="html-doc-refused" data-reason={opened.reason}>
                    <AlertCircle size={16} />
                    <span>{opened.message}</span>
                </div>
            </Centered>
        )
    }
    return (
        <iframe
            ref={frameRef}
            data-testid="html-doc-frame"
            data-path={path}
            title={path.split('/').pop() ?? 'Document'}
            src={opened.url}
            sandbox={DOC_PREVIEW_SANDBOX}
            referrerPolicy="no-referrer"
            className="w-full h-full border-0 bg-white block"
        />
    )
}

function HtmlSource({ path, line }: { path: string; line?: number }) {
    const [state, setState] = useState<{ content: string } | { error: string } | null>(null)
    const scrollRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
        let live = true
        setState(null)
        window.api.readFileContent(path).then(
            (result) => live && setState(result.success && result.content !== undefined ? { content: result.content } : { error: result.error || 'Failed to read file' }),
            (error: unknown) => live && setState({ error: error instanceof Error ? error.message : String(error) })
        )
        return () => {
            live = false
        }
    }, [path])

    useEffect(() => {
        if (!state || !('content' in state) || !line) return
        const timer = setTimeout(() => scrollRef.current?.querySelector(`.line-${line}`)?.scrollIntoView({ block: 'center' }), 50)
        return () => clearTimeout(timer)
    }, [state, line])

    if (!state) return <Centered><Loader2 size={20} className="text-blue-400 animate-spin" /></Centered>
    if ('error' in state) {
        return (
            <Centered>
                <div className="flex items-center gap-2 text-red-400 text-sm">
                    <AlertCircle size={16} />
                    <span>{state.error}</span>
                </div>
            </Centered>
        )
    }
    return (
        <div ref={scrollRef} className="h-full overflow-auto bg-[#1e1e1e]" data-testid="html-doc-source">
            <SyntaxHighlighter
                language="html"
                style={vscDarkPlus}
                showLineNumbers
                wrapLines
                lineProps={(lineNumber) => ({
                    className: `line-${lineNumber}${lineNumber === line ? ' bg-yellow-500/20' : ''}`,
                    style: { display: 'block' }
                })}
                customStyle={{ margin: 0, padding: '0.75rem', fontSize: '12px', lineHeight: '1.4', background: 'transparent' }}
                codeTagProps={{ style: { fontFamily: "'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace" } }}
            >
                {state.content}
            </SyntaxHighlighter>
        </div>
    )
}

const Centered = ({ children }: { children: ReactNode }) => <div className="flex items-center justify-center h-full min-h-32">{children}</div>
