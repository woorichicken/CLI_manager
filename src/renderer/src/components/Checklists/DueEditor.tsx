import React, { useEffect, useRef, useState } from 'react'
import { CalendarDays } from 'lucide-react'
import { describeDue, DUE_TONE_CLASSES } from '../../utils/dueDate'

// A deadline picked or typed is saved this long after the last change, without waiting for blur:
// picking a day in the calendar does not blur the field, and nobody expects to click away to save.
const DUE_SAVE_DELAY_MS = 600

/**
 * A date worth saving while the field is still being edited: empty (cleared), or complete with a
 * four-digit year. Typing a year digit by digit reports 0002, 0020, 0202 on the way to 2026.
 */
function isSettledDue(value: string): boolean {
    if (value === '') return true
    const match = /^(\d{4})-\d{2}-\d{2}$/.exec(value)
    return match !== null && Number(match[1]) >= 1000
}

interface DueEditorProps {
    due?: string
    todayKey: string
    /** Every item is checked: the deadline no longer matters, so it is shown grey. */
    complete: boolean
    onSave: (due: string | null) => void
}

/**
 * The checklist's deadline: a chip ("Tue", "2d overdue") that turns into a date field on
 * click, or "Set due" when there is none. An empty field clears it.
 */
export function DueEditor({ due, todayKey, complete, onSave }: DueEditorProps) {
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(due ?? '')
    const inputRef = useRef<HTMLInputElement>(null)
    // Esc ends the edit by blurring the field; the blur must not save what Esc discarded.
    const discardRef = useRef(false)
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
    // The delayed save compares with the deadline main sent last, not the one this render saw.
    const savedRef = useRef(due ?? '')
    savedRef.current = due ?? ''

    useEffect(() => () => {
        if (timerRef.current) clearTimeout(timerRef.current)
    }, [])

    useEffect(() => {
        if (!editing) return
        const input = inputRef.current
        input?.focus()
        try {
            input?.showPicker()
        } catch {
            // showPicker needs a user gesture; typing the date still works.
        }
    }, [editing])

    const save = (value: string): void => {
        if (value !== savedRef.current) onSave(value || null)
    }

    const change = (value: string): void => {
        setDraft(value)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = isSettledDue(value) ? setTimeout(() => save(value), DUE_SAVE_DELAY_MS) : null
    }

    // Blur and Enter save at once; Esc drops what is waiting.
    const commit = (): void => {
        setEditing(false)
        if (timerRef.current) clearTimeout(timerRef.current)
        timerRef.current = null
        if (discardRef.current) {
            discardRef.current = false
            return
        }
        if (isSettledDue(draft)) save(draft)
    }

    const keys = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
            discardRef.current = true
            e.currentTarget.blur()
        }
    }

    const start = (): void => {
        setDraft(due ?? '')
        setEditing(true)
    }

    if (editing) {
        return (
            <input
                ref={inputRef}
                type="date"
                data-testid="checklist-due-input"
                value={draft}
                onChange={(e) => change(e.target.value)}
                onBlur={commit}
                onKeyDown={keys}
                className="w-[7.5rem] max-w-full bg-white/10 rounded px-1 text-[11px] text-gray-100 outline-none [color-scheme:dark]"
            />
        )
    }

    if (!due) {
        return (
            <button data-testid="checklist-set-due" onClick={start} className="flex items-center gap-1 text-gray-500 hover:text-gray-300" title="Set a deadline">
                <CalendarDays size={11} />
                Set due
            </button>
        )
    }

    const described = describeDue(due, todayKey)
    return (
        <button
            data-testid="checklist-due"
            data-due-tone={described.tone}
            onClick={start}
            className={`px-1.5 rounded border text-[10px] leading-4 tabular-nums ${complete ? 'text-gray-500 border-white/10' : DUE_TONE_CLASSES[described.tone]}`}
            title={`Due ${due} — click to change`}
        >
            Due {described.label}
        </button>
    )
}
