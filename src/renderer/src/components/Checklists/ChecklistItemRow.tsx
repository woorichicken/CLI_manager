import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { ChecklistItem } from '../../../../shared/types'

interface ChecklistItemRowProps {
    checklistId: string
    item: ChecklistItem
}

/**
 * One item: check it, double-click the text to rename it, × to delete. A checked item
 * keeps its place and is struck through — the order is the plan. Every change goes to
 * main, which sends the new list back; the row keeps no copy of its own.
 */
export function ChecklistItemRow({ checklistId, item }: ChecklistItemRowProps) {
    const done = item.doneAt !== undefined
    const [editing, setEditing] = useState(false)
    const [draft, setDraft] = useState(item.text)
    const inputRef = useRef<HTMLInputElement>(null)
    // Esc ends the edit by blurring the input; the blur must not save what Esc discarded.
    const discardRef = useRef(false)

    useEffect(() => {
        if (editing) inputRef.current?.select()
    }, [editing])

    const commit = (): void => {
        setEditing(false)
        if (discardRef.current) {
            discardRef.current = false
            return
        }
        const text = draft.replace(/\s+/g, ' ').trim()
        if (text && text !== item.text) void window.api.updateChecklistItem(checklistId, item.id, { text })
    }

    const keys = (e: React.KeyboardEvent<HTMLInputElement>): void => {
        e.stopPropagation()
        if (e.key === 'Enter') e.currentTarget.blur()
        if (e.key === 'Escape') {
            discardRef.current = true
            e.currentTarget.blur()
        }
    }

    return (
        <li
            data-checklist-item={item.id}
            data-item-done={done ? 'true' : 'false'}
            className="group flex items-start gap-2 px-3 py-1 hover:bg-white/5"
        >
            <input
                type="checkbox"
                data-testid="checklist-item-check"
                checked={done}
                onChange={() => void window.api.updateChecklistItem(checklistId, item.id, { done: !done })}
                className="mt-1 shrink-0 accent-emerald-500 cursor-pointer"
                aria-label={done ? `Uncheck "${item.text}"` : `Check "${item.text}"`}
            />
            {editing ? (
                <input
                    ref={inputRef}
                    data-testid="checklist-item-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commit}
                    onKeyDown={keys}
                    maxLength={200}
                    className="flex-1 min-w-0 bg-white/10 rounded px-1 text-xs leading-5 text-gray-100 outline-none"
                />
            ) : (
                <span
                    data-testid="checklist-item-text"
                    onDoubleClick={() => {
                        setDraft(item.text)
                        setEditing(true)
                    }}
                    title={item.text}
                    className={`flex-1 min-w-0 text-xs leading-5 break-words cursor-default ${done ? 'line-through text-gray-500' : 'text-gray-200'}`}
                >
                    {item.text}
                </span>
            )}
            <button
                data-testid="checklist-item-remove"
                onClick={() => void window.api.removeChecklistItem(checklistId, item.id)}
                className="shrink-0 mt-1 text-gray-500 hover:text-red-300 opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                title="Delete item"
                aria-label={`Delete "${item.text}"`}
            >
                <X size={12} />
            </button>
        </li>
    )
}
