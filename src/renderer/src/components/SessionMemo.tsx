import React, { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from 'react'
import { StickyNote, X } from 'lucide-react'

interface SessionMemoProps {
    sessionId: string
    workspaceId: string
    initialMemo?: string
    visible: boolean
}

export interface SessionMemoHandle {
    toggle: () => void
}

// Debounce delay for auto-saving memo (ms)
const SAVE_DEBOUNCE_MS = 500

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

// Focus the xterm terminal in the same container
function focusTerminal(sessionId: string): void {
    const xtermEl = document.querySelector(`[data-session-id="${sessionId}"] .xterm textarea`) as HTMLElement | null
    xtermEl?.focus()
}

export const SessionMemo = forwardRef<SessionMemoHandle, SessionMemoProps>(
    function SessionMemo({ sessionId, workspaceId, initialMemo, visible }, ref) {
        const [isOpen, setIsOpen] = useState(false)
        const [memo, setMemo] = useState(initialMemo || '')
        // Typing happens in the textarea; while the memo is not being edited it is shown as text
        // so its links can be clicked. An empty memo has nothing to read, so it stays the textarea.
        const [isEditing, setIsEditing] = useState(true)
        const saveTimerRef = useRef<NodeJS.Timeout | null>(null)
        const textareaRef = useRef<HTMLTextAreaElement>(null)

        // Sync with external initialMemo changes (e.g., session switch)
        useEffect(() => {
            setMemo(initialMemo || '')
        }, [initialMemo, sessionId])

        // Auto-save memo with debounce
        const saveMemo = useCallback((text: string) => {
            if (saveTimerRef.current) {
                clearTimeout(saveTimerRef.current)
            }
            saveTimerRef.current = setTimeout(() => {
                window.api.updateSessionMemo(workspaceId, sessionId, text)
            }, SAVE_DEBOUNCE_MS)
        }, [workspaceId, sessionId])

        // Cleanup timer on unmount
        useEffect(() => {
            return () => {
                if (saveTimerRef.current) {
                    clearTimeout(saveTimerRef.current)
                }
            }
        }, [])

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
            const newText = e.target.value
            setMemo(newText)
            saveMemo(newText)
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
            else if (e.key === 'Enter') setIsEditing(true)
            e.stopPropagation()
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
                            : memo
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
                            <button
                                onClick={closeMemo}
                                className="text-gray-500 hover:text-gray-300 transition-colors"
                            >
                                <X size={12} />
                            </button>
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
                                onClick={() => setIsEditing(true)}
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
