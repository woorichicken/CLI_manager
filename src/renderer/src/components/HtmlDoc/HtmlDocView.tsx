import { useCallback, useEffect, useRef, useState, type MutableRefObject, type ReactNode } from 'react'
import { AlertCircle, Loader2 } from 'lucide-react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism'
import type { DocPreviewOpenResult } from '../../../../shared/docPreview'
import { DOC_PREVIEW_MESSAGE, DOC_PREVIEW_SANDBOX, docPreviewSibling } from '../../../../shared/docPreview'

/**
 * An HTML report, drawn or as its source — the preview window's body (A) and a split pane's (B).
 *
 * Drawn: a sandboxed frame on `climanager-doc:` (decision 0013). The page gets an opaque origin, so it cannot reach
 * `window.api`; its policy refuses every connection. It tells us only of a press inside it and a link to a page beside it
 * (the bridge in main/docPreview.ts) — Escape is the page's own (b6a75106).
 * Leaving (ec4c1682): when the person typed in the page and copied nothing (the bridge's `dirty`), whatever closes or replaces
 * this page asks first, in the app — an owner calls `leaveGuard.current(action)` instead of the action. The page's words stay
 * in the page; only the fact that there are uncopied ones crosses.
 * Source: the text preview's reader, so its 500 KB limit applies there — drawing has the phone's 64 MB.
 */
/** What an owner calls to close or replace the page: `action` runs now, or after «Close anyway» when writing would be lost. */
export type DocLeaveGuard = MutableRefObject<((action: () => void) => void) | null>

interface HtmlDocViewProps {
    path: string
    line?: number
    source: boolean
    /** a link to another page of the folder: the owner shows that path instead */
    onNavigate?: (path: string) => void
    /** the page took the focus (a click inside it): clicks in a frame never reach this document */
    onFrameFocus?: () => void
    /** filled while the drawn page is up: ask it before closing or replacing the page */
    leaveGuard?: DocLeaveGuard
}

export function HtmlDocView({ path, line, source, onNavigate, onFrameFocus, leaveGuard }: HtmlDocViewProps) {
    return source ? <HtmlSource path={path} line={line} /> : <HtmlFrame path={path} onNavigate={onNavigate} onFrameFocus={onFrameFocus} leaveGuard={leaveGuard} />
}

function HtmlFrame({ path, onNavigate, onFrameFocus, leaveGuard }: Pick<HtmlDocViewProps, 'path' | 'onNavigate' | 'onFrameFocus' | 'leaveGuard'>) {
    const [opened, setOpened] = useState<DocPreviewOpenResult | null>(null)
    const frameRef = useRef<HTMLIFrameElement>(null)
    const handlers = useRef({ onNavigate, onFrameFocus, path })
    handlers.current = { onNavigate, onFrameFocus, path }
    // typed and not copied, as the bridge last said; and what waits for «Close anyway»
    const dirty = useRef(false)
    const [pending, setPending] = useState<(() => void) | null>(null)
    const pendingRef = useRef<(() => void) | null>(null)
    pendingRef.current = pending
    const guard = useCallback((action: () => void): void => {
        // asked again while the question is up (Escape, a click outside): that is «Keep open»
        if (pendingRef.current) return setPending(null)
        if (dirty.current) setPending(() => action)
        else action()
    }, [])
    useEffect(() => {
        if (!leaveGuard) return
        leaveGuard.current = guard
        return () => {
            if (leaveGuard.current === guard) leaveGuard.current = null
        }
    }, [leaveGuard, guard])

    useEffect(() => {
        let live = true
        setOpened(null)
        // a new page starts clean
        dirty.current = false
        setPending(null)
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
            const data = event.data as { type?: unknown; open?: unknown; pressed?: unknown; dirty?: unknown } | null
            if (data?.type !== DOC_PREVIEW_MESSAGE) return
            if (typeof data.dirty === 'boolean') dirty.current = data.dirty
            if (data.pressed === true) handlers.current.onFrameFocus?.()
            const sibling = docPreviewSibling(handlers.current.path, data.open)
            if (sibling && handlers.current.onNavigate) {
                const go = handlers.current.onNavigate
                guard(() => go(sibling))
            }
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
    }, [guard])

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
        <div className="relative w-full h-full">
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
            {pending && (
                <div
                    role="alertdialog"
                    aria-label="Comments not copied"
                    data-testid="html-doc-leave-confirm"
                    className="absolute inset-x-0 bottom-0 z-10 flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-t border-amber-500/40 bg-[#2a2418] text-amber-100 text-xs shadow-2xl"
                    onKeyDown={(event) => {
                        // these keys are this question's: the preview window behind it would read Space as close and Enter as Browser
                        if (event.key === 'Escape') {
                            event.preventDefault()
                            event.stopPropagation()
                            setPending(null)
                        } else if (event.key === 'Enter' || event.key === ' ') {
                            event.stopPropagation()
                        }
                    }}
                >
                    <span className="flex-1 min-w-48">Comments you typed here weren&apos;t copied. They&apos;ll be lost when this closes.</span>
                    <button
                        type="button"
                        autoFocus
                        data-testid="html-doc-leave-keep"
                        onClick={() => setPending(null)}
                        className="px-2.5 py-1 rounded bg-white/15 text-white hover:bg-white/25 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300"
                    >
                        Keep open
                    </button>
                    <button
                        type="button"
                        data-testid="html-doc-leave-anyway"
                        onClick={() => {
                            const action = pending
                            setPending(null)
                            action()
                        }}
                        className="px-2.5 py-1 rounded text-red-300 hover:bg-red-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                    >
                        Close anyway
                    </button>
                </div>
            )}
        </div>
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
