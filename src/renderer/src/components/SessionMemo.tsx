import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import { Check, ChevronLeft, ChevronRight, Copy, FilePlus, StickyNote, Trash2, X } from 'lucide-react'

interface SessionMemoProps {
    sessionId: string
    workspaceId: string
    /** Page 1 of the memo. */
    initialMemo?: string
    /** Pages 2..n (`TerminalSession.memoPages`). */
    initialMemoPages?: string[]
    visible: boolean
}

export interface SessionMemoHandle {
    toggle: () => void
}

// Debounce delay for auto-saving memo (ms)
const SAVE_DEBOUNCE_MS = 500

// How long the copy button shows its check mark after copying (ms).
const COPIED_FEEDBACK_MS = 1500

// The delete-page button asks for a second click this long before it resets (ms).
const DELETE_CONFIRM_MS = 3000

// A link in the reading view is shown at about this many characters; the tooltip has the whole URL.
const LINK_DISPLAY_MAX_CHARS = 40

// Memos are plain text the user typed. Only web links are made clickable: a subset of what a
// terminal may hand to the OS (TerminalView's ALLOWED_LINK_PROTOCOLS), so nothing new can open.
const MEMO_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/g
const TRAILING_PUNCTUATION = /[.,;:!?'"]+$/

export type MemoSegment = { type: 'text'; text: string } | { type: 'link'; url: string }

/** Drops what a sentence puts after a URL: "see https://x.dev/a)." links https://x.dev/a. */
function trimUrlEnd(raw: string): string {
    let url = raw
    for (;;) {
        const stripped = url.replace(TRAILING_PUNCTUATION, '')
        const closer = stripped.slice(-1)
        const opener = closer === ')' ? '(' : closer === ']' ? '[' : closer === '}' ? '{' : ''
        // A closing bracket belongs to the URL only when it has its opener inside it (wiki links).
        const unbalanced = opener !== '' && stripped.split(closer).length > stripped.split(opener).length
        const next = unbalanced ? stripped.slice(0, -1) : stripped
        if (next === url) return url
        url = next
    }
}

/** Splits memo text into plain runs and http(s) links, keeping every character of the text. */
export function splitMemoLinks(text: string): MemoSegment[] {
    const segments: MemoSegment[] = []
    let cursor = 0
    for (const match of text.matchAll(MEMO_URL_PATTERN)) {
        const url = trimUrlEnd(match[0])
        const start = match.index ?? 0
        try {
            new URL(url)
        } catch {
            continue
        }
        if (start > cursor) segments.push({ type: 'text', text: text.slice(cursor, start) })
        segments.push({ type: 'link', url })
        cursor = start + url.length
    }
    if (cursor < text.length) segments.push({ type: 'text', text: text.slice(cursor) })
    return segments
}

/** "docs.example.com/…/page-name": host plus the last path piece, about LINK_DISPLAY_MAX_CHARS long. */
export function shortenUrl(url: string, maxChars = LINK_DISPLAY_MAX_CHARS): string {
    const parsed = new URL(url)
    const host = parsed.host.replace(/^www\./, '')
    const path = parsed.pathname.replace(/\/+$/, '')
    const whole = `${host}${path}${parsed.search}${parsed.hash}`
    if (whole.length <= maxChars) return whole

    const pieces = path.split('/').filter(Boolean)
    const last = pieces[pieces.length - 1] ?? ''
    const short = pieces.length > 1 ? `${host}/…/${last}` : `${host}/${last}`
    return short.length <= maxChars ? short : `${short.slice(0, maxChars - 1)}…`
}

/** A session's memo as pages: page 1 is the `memo` field, the rest come from `memoPages`. */
export function memoPagesOf(memo?: string, morePages?: string[]): string[] {
    return [memo ?? '', ...(morePages ?? [])]
}

/** The page shown after moving `step` pages from `index`. Going past either end wraps around. */
export function turnMemoPage(index: number, step: number, pageCount: number): number {
    if (pageCount <= 0) return 0
    return ((index + step) % pageCount + pageCount) % pageCount
}

/** Pages left after deleting one, and the page to show next: the one that took its place, or the new last one. */
export function deleteMemoPage(pages: string[], index: number): { pages: string[]; index: number } {
    if (pages.length <= 1) return { pages: [''], index: 0 }
    const rest = pages.filter((_, i) => i !== index)
    return { pages: rest, index: Math.min(index, rest.length - 1) }
}

// Focus the xterm terminal in the same container
function focusTerminal(sessionId: string): void {
    const xtermEl = document.querySelector(`[data-session-id="${sessionId}"] .xterm textarea`) as HTMLElement | null
    xtermEl?.focus()
}

export const SessionMemo = forwardRef<SessionMemoHandle, SessionMemoProps>(
    function SessionMemo({ sessionId, workspaceId, initialMemo, initialMemoPages, visible }, ref) {
        const [isOpen, setIsOpen] = useState(false)
        // Pages instead of one sheet split by "-----" lines (report 533a22ba). Page 1 is what older builds show.
        const [pages, setPages] = useState<string[]>(() => memoPagesOf(initialMemo, initialMemoPages))
        const [pageIndex, setPageIndex] = useState(0)
        const [confirmingDelete, setConfirmingDelete] = useState(false)
        const confirmTimerRef = useRef<NodeJS.Timeout | null>(null)
        const memo = pages[pageIndex] ?? ''
        const hasAnyText = pages.some(page => page.length > 0)
        // Typing happens in the textarea; while the memo is not being edited it is shown as text
        // so its links can be clicked. An empty memo has nothing to read, so it stays the textarea.
        const [isEditing, setIsEditing] = useState(true)
        const saveTimerRef = useRef<NodeJS.Timeout | null>(null)
        const textareaRef = useRef<HTMLTextAreaElement>(null)
        const [copied, setCopied] = useState(false)
        const copiedTimerRef = useRef<NodeJS.Timeout | null>(null)

        // Sync with external memo changes (e.g., session switch). Compared by value: the pages
        // array is a new object on every workspace refresh, and that must not reset the page shown.
        const storedPagesKey = JSON.stringify(memoPagesOf(initialMemo, initialMemoPages))
        useEffect(() => {
            const stored = JSON.parse(storedPagesKey) as string[]
            setPages(stored)
            setPageIndex(index => Math.min(index, stored.length - 1))
        }, [storedPagesKey, sessionId])

        // Auto-save memo with debounce. Every save sends all pages, so the last one written wins whole.
        const savePages = useCallback((next: string[]) => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current)
            }
            saveTimerRef.current = setTimeout(() => {
                window.api.updateSessionMemo(workspaceId, sessionId, next[0] ?? '', next.slice(1))
            }, SAVE_DEBOUNCE_MS)
        }, [workspaceId, sessionId])

        // Cleanup timer on unmount
        useEffect(() => {
            return () => {
                if (saveTimerRef.current) {
                    clearTimeout(saveTimerRef.current)
                }
                if (copiedTimerRef.current) {
                    clearTimeout(copiedTimerRef.current)
                }
                if (confirmTimerRef.current) {
                    clearTimeout(confirmTimerRef.current)
                }
            }
        }, [])

        // Copies the page on screen, so it can be pasted to an agent without selecting it first (report 533a22ba).
        const copyMemo = useCallback(async () => {
            if (!memo) return
            try {
                await navigator.clipboard.writeText(memo)
            } catch (err) {
                console.error('Failed to copy memo:', err)
                return
            }
            setCopied(true)
            if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current)
            copiedTimerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
        }, [memo])

        const openMemo = useCallback(() => {
            setIsOpen(true)
            setIsEditing(true)
            setTimeout(() => {
                const ta = textareaRef.current
                if (ta) {
                    ta.focus()
                    ta.selectionStart = ta.selectionEnd = ta.value.length
                }
            }, 50)
        }, [])

        const closeMemo = useCallback(() => {
            setIsOpen(false)
            // Return focus to terminal
            setTimeout(() => focusTerminal(sessionId), 50)
        }, [sessionId])

        const handleToggle = useCallback(() => {
            if (isOpen) {
                closeMemo()
            } else {
                openMemo()
            }
        }, [isOpen, openMemo, closeMemo])

        // Expose toggle method for keyboard shortcut
        useImperativeHandle(ref, () => ({
            toggle: handleToggle,
        }), [handleToggle])

        const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
            const next = pages.map((page, i) => i === pageIndex ? e.target.value : page)
            setPages(next)
            savePages(next)
        }

        const cancelDeleteConfirm = () => {
            setConfirmingDelete(false)
            if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
        }

        const turnPage = (step: number) => {
            cancelDeleteConfirm()
            setPageIndex(index => turnMemoPage(index, step, pages.length))
        }

        // A new page goes at the end and opens for typing.
        const addPage = () => {
            cancelDeleteConfirm()
            const next = [...pages, '']
            setPages(next)
            setPageIndex(next.length - 1)
            setIsEditing(true)
            savePages(next)
            setTimeout(() => textareaRef.current?.focus(), 0)
        }

        // An empty page goes at once; a page with text asks for a second click, since there is no undo.
        const deletePage = () => {
            if (memo.length > 0 && !confirmingDelete) {
                setConfirmingDelete(true)
                if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current)
                confirmTimerRef.current = setTimeout(() => setConfirmingDelete(false), DELETE_CONFIRM_MS)
                return
            }
            cancelDeleteConfirm()
            const next = deleteMemoPage(pages, pageIndex)
            setPages(next.pages)
            setPageIndex(next.index)
            savePages(next.pages)
        }

        // Entering the edit mode mounts a fresh textarea: put the caret at the end like openMemo does.
        useEffect(() => {
            if (!isOpen || !isEditing) return
            const ta = textareaRef.current
            if (ta && document.activeElement !== ta) {
                ta.focus()
                ta.selectionStart = ta.selectionEnd = ta.value.length
            }
        }, [isOpen, isEditing])

        const openLink = (e: React.MouseEvent, url: string) => {
            e.preventDefault()
            e.stopPropagation()
            window.api.openExternal(url)
        }

        const handleReadViewKeyDown = (e: React.KeyboardEvent) => {
            if (e.key === 'Escape') closeMemo()
            // Enter on a focused link opens that link (its own click); only Enter on the memo itself starts editing.
            else if (e.key === 'Enter' && !(e.target as HTMLElement).closest('a')) setIsEditing(true)
            e.stopPropagation()
        }

        const handleReadViewClick = (e: React.MouseEvent<HTMLDivElement>) => {
            // Selecting text by dragging ends in a click too: keep the selection rather than swap in the textarea.
            const selection = window.getSelection()
            if (selection && !selection.isCollapsed && e.currentTarget.contains(selection.anchorNode)) return
            setIsEditing(true)
        }

        // Keyboard shortcut: Escape to close
        const handleKeyDown = (e: React.KeyboardEvent) => {
            if (e.key === 'Escape') {
                closeMemo()
            }
            // Prevent terminal from capturing keystrokes
            e.stopPropagation()
        }

        if (!visible) return null

        return (
            <>
                {/* Toggle button - always visible at top-right */}
                <button
                    onClick={handleToggle}
                    className={`absolute top-2 right-14 z-30 w-7 h-7 flex items-center justify-center rounded-md transition-all duration-200 ${
                        isOpen
                            ? 'bg-yellow-500/30 text-yellow-300'
                            : hasAnyText
                                ? 'bg-yellow-500/20 text-yellow-400 opacity-60 hover:opacity-100'
                                : 'bg-white/5 text-gray-500 opacity-40 hover:opacity-100'
                    }`}
                    title="Session Memo (⌘J)"
                >
                    <StickyNote size={14} />
                </button>

                {/* Memo panel */}
                {isOpen && (
                    <div className="absolute top-1 right-1 z-30 w-72 bg-gray-900/95 backdrop-blur-sm border border-gray-700/50 rounded-lg shadow-2xl flex flex-col overflow-hidden">
                        {/* Header */}
                        <div className="flex items-center justify-between px-3 py-2 border-b border-gray-700/50">
                            <span className="text-xs text-gray-400 font-medium">Memo</span>
                            <div className="flex items-center gap-2">
                                {/* Header buttons keep the textarea focused (mousedown is cancelled): a blur would switch it to the reading view. */}
                                {pages.length > 1 && (
                                    <div className="flex items-center gap-0.5" data-testid="session-memo-pager">
                                        <button
                                            data-testid="session-memo-prev"
                                            onClick={() => turnPage(-1)}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className="text-gray-500 hover:text-gray-300 transition-colors"
                                            title="Previous page"
                                            aria-label="Previous page"
                                        >
                                            <ChevronLeft size={12} />
                                        </button>
                                        <span data-testid="session-memo-page" className="text-[10px] text-gray-400 tabular-nums min-w-[2.25rem] text-center">
                                            {pageIndex + 1} / {pages.length}
                                        </span>
                                        <button
                                            data-testid="session-memo-next"
                                            onClick={() => turnPage(1)}
                                            onMouseDown={(e) => e.preventDefault()}
                                            className="text-gray-500 hover:text-gray-300 transition-colors"
                                            title="Next page"
                                            aria-label="Next page"
                                        >
                                            <ChevronRight size={12} />
                                        </button>
                                    </div>
                                )}
                                <button
                                    data-testid="session-memo-new-page"
                                    onClick={addPage}
                                    onMouseDown={(e) => e.preventDefault()}
                                    className="text-gray-500 hover:text-gray-300 transition-colors"
                                    title="New page"
                                    aria-label="New page"
                                >
                                    <FilePlus size={12} />
                                </button>
                                {pages.length > 1 && (
                                    <button
                                        data-testid="session-memo-delete-page"
                                        data-state={confirmingDelete ? 'confirm' : 'idle'}
                                        onClick={deletePage}
                                        onMouseDown={(e) => e.preventDefault()}
                                        className={`transition-colors ${confirmingDelete ? 'text-red-400' : 'text-gray-500 hover:text-gray-300'}`}
                                        title={confirmingDelete ? 'Click again to delete this page' : 'Delete this page'}
                                        aria-label={confirmingDelete ? 'Click again to delete this page' : 'Delete this page'}
                                    >
                                        <Trash2 size={12} />
                                    </button>
                                )}
                                <button
                                    data-testid="session-memo-copy"
                                    onClick={copyMemo}
                                    // Keep the textarea focused: a blur would switch it to the reading view.
                                    onMouseDown={(e) => e.preventDefault()}
                                    disabled={!memo}
                                    className={`transition-colors disabled:opacity-30 disabled:cursor-default ${
                                        copied ? 'text-emerald-400' : 'text-gray-500 hover:text-gray-300'
                                    }`}
                                    title={copied ? 'Copied' : pages.length > 1 ? 'Copy this page' : 'Copy memo'}
                                    aria-label={copied ? 'Copied' : pages.length > 1 ? 'Copy this page' : 'Copy memo'}
                                >
                                    {copied ? <Check size={12} /> : <Copy size={12} />}
                                </button>
                                <button
                                    onClick={closeMemo}
                                    className="text-gray-500 hover:text-gray-300 transition-colors"
                                >
                                    <X size={12} />
                                </button>
                            </div>
                        </div>
                        {isEditing || !memo ? (
                            <textarea
                                ref={textareaRef}
                                value={memo}
                                onChange={handleChange}
                                onKeyDown={handleKeyDown}
                                // Leaving the window blurs the textarea too; that is not "done editing".
                                onBlur={() => { if (document.hasFocus()) setIsEditing(false) }}
                                placeholder="Quick notes..."
                                className="w-full h-32 px-3 py-2 bg-transparent text-sm text-gray-200 placeholder-gray-600 resize-none outline-none"
                                spellCheck={false}
                            />
                        ) : (
                            // Reading view: links are shortened and clickable, anywhere else goes back to editing.
                            <div
                                data-testid="session-memo-read"
                                tabIndex={0}
                                onClick={handleReadViewClick}
                                onKeyDown={handleReadViewKeyDown}
                                className="w-full h-32 px-3 py-2 text-sm text-gray-200 whitespace-pre-wrap break-words overflow-y-auto cursor-text outline-none"
                            >
                                {splitMemoLinks(memo).map((segment, index) => segment.type === 'text' ? (
                                    <React.Fragment key={index}>{segment.text}</React.Fragment>
                                ) : (
                                    <a
                                        key={index}
                                        data-memo-link
                                        href={segment.url}
                                        title={segment.url}
                                        onClick={(e) => openLink(e, segment.url)}
                                        className="text-blue-400 underline decoration-blue-400/40 hover:text-blue-300 cursor-pointer break-all"
                                    >
                                        {shortenUrl(segment.url)}
                                    </a>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </>
        )
    }
)
