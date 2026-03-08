import React, { useState, useEffect, useRef, useCallback } from 'react'
import { StickyNote, X } from 'lucide-react'

interface SessionMemoProps {
    sessionId: string
    workspaceId: string
    initialMemo?: string
    visible: boolean
}

// Debounce delay for auto-saving memo (ms)
const SAVE_DEBOUNCE_MS = 500

export function SessionMemo({ sessionId, workspaceId, initialMemo, visible }: SessionMemoProps) {
    const [isOpen, setIsOpen] = useState(false)
    const [memo, setMemo] = useState(initialMemo || '')
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

    const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const newText = e.target.value
        setMemo(newText)
        saveMemo(newText)
    }

    const handleToggle = () => {
        const next = !isOpen
        setIsOpen(next)
        if (next) {
            // Focus textarea and move cursor to end
            setTimeout(() => {
                const ta = textareaRef.current
                if (ta) {
                    ta.focus()
                    ta.selectionStart = ta.selectionEnd = ta.value.length
                }
            }, 50)
        }
    }

    // Keyboard shortcut: Escape to close
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Escape') {
            setIsOpen(false)
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
                title="Session Memo"
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
                            onClick={() => setIsOpen(false)}
                            className="text-gray-500 hover:text-gray-300 transition-colors"
                        >
                            <X size={12} />
                        </button>
                    </div>
                    {/* Textarea */}
                    <textarea
                        ref={textareaRef}
                        value={memo}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        placeholder="Quick notes..."
                        className="w-full h-32 px-3 py-2 bg-transparent text-sm text-gray-200 placeholder-gray-600 resize-none outline-none"
                        spellCheck={false}
                    />
                </div>
            )}
        </>
    )
}
