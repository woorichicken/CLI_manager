import React, { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Plus, Trash2, X } from 'lucide-react'
import type { Workspace } from '../../../../shared/types'
import type { CurrentChecklist } from '../../hooks/useChecklists'
import { ChecklistItemRow } from './ChecklistItemRow'
import { DueEditor } from './DueEditor'

interface ChecklistPanelProps {
    nav: CurrentChecklist
    workspaces: Workspace[]
    activeWorkspaceId?: string
    todayKey: string
    onClose: () => void
    style: React.CSSProperties
}

// Delay before focusing a field the panel just rendered (ms) — the beat the memo uses.
const FOCUS_DELAY_MS = 50
// The second click on Delete must come within this time, or the first one is forgotten.
const DELETE_CONFIRM_MS = 3000

/** A field where ← → and Esc mean something already (a checkbox is not one). */
function isTextField(target: EventTarget | null): boolean {
    if (target instanceof HTMLInputElement) return target.type !== 'checkbox'
    return target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement
}

/**
 * The checklist panel under the header chip: ‹ › pages through checklists (also ← → when no
 * field has focus), the title renames on double-click, project and deadline sit under it,
 * then the items and a field to add one. "New checklist" starts another one for the
 * project in view.
 */
export function ChecklistPanel({ nav, workspaces, activeWorkspaceId, todayKey, onClose, style }: ChecklistPanelProps) {
    const { checklists, current, index, page, select } = nav
    const ref = useRef<HTMLDivElement>(null)
    const addRef = useRef<HTMLInputElement>(null)
    const newRef = useRef<HTMLInputElement>(null)
    const [creating, setCreating] = useState(false)
    const [newTitle, setNewTitle] = useState('')
    const [itemDraft, setItemDraft] = useState('')
    const [editingTitle, setEditingTitle] = useState(false)
    const [titleDraft, setTitleDraft] = useState('')
    const [confirmDelete, setConfirmDelete] = useState(false)
    const showNewForm = creating || checklists.length === 0

    const sessionNames = useMemo(() => {
        const names = new Map<string, string>()
        for (const workspace of workspaces) for (const session of workspace.sessions ?? []) names.set(session.id, session.name)
        return names
    }, [workspaces])

    // First field on open: the item field when there is a checklist, else the new title.
    useEffect(() => {
        const timer = setTimeout(() => (checklists.length > 0 ? addRef.current : newRef.current)?.focus(), FOCUS_DELAY_MS)
        return () => clearTimeout(timer)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    useEffect(() => {
        const onPointerDown = (e: PointerEvent): void => {
            const target = e.target as HTMLElement | null
            if (ref.current?.contains(target) || target?.closest('[data-testid="checklist-chip"]')) return
            onClose()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        return () => document.removeEventListener('pointerdown', onPointerDown, true)
    }, [onClose])

    useEffect(() => {
        setConfirmDelete(false)
        setEditingTitle(false)
    }, [current?.id])

    useEffect(() => {
        if (!confirmDelete) return
        const timer = setTimeout(() => setConfirmDelete(false), DELETE_CONFIRM_MS)
        return () => clearTimeout(timer)
    }, [confirmDelete])

    const panelKeys = (e: React.KeyboardEvent): void => {
        // The terminal listens on the window: keep typing here out of it.
        e.stopPropagation()
        if (e.key === 'Escape' && !isTextField(e.target)) onClose()
        if (!isTextField(e.target) && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault()
            page(e.key === 'ArrowLeft' ? -1 : 1)
        }
    }

    // Esc in a field: first leaves an edit, else closes the panel.
    const fieldKeys = (e: React.KeyboardEvent<HTMLInputElement>, onEscape: () => void): void => {
        e.stopPropagation()
        if (e.key === 'Escape') onEscape()
    }

    const createChecklist = async (e: React.FormEvent): Promise<void> => {
        e.preventDefault()
        const title = newTitle.trim()
        if (!title) return
        const id = await window.api.createChecklist(title, activeWorkspaceId)
        if (!id) return
        select(id)
        setNewTitle('')
        setCreating(false)
        setTimeout(() => addRef.current?.focus(), FOCUS_DELAY_MS)
    }

    const addItem = async (e: React.FormEvent): Promise<void> => {
        e.preventDefault()
        if (!current || !itemDraft.trim()) return
        if (await window.api.addChecklistItem(current.id, itemDraft)) setItemDraft('')
    }

    const commitTitle = (): void => {
        setEditingTitle(false)
        const title = titleDraft.replace(/\s+/g, ' ').trim()
        if (current && title && title !== current.title) void window.api.updateChecklist(current.id, { title })
    }

    const remove = (): void => {
        if (!current) return
        if (!confirmDelete) return setConfirmDelete(true)
        void window.api.removeChecklist(current.id)
        setConfirmDelete(false)
    }

    const done = current ? current.items.filter((i) => i.doneAt !== undefined).length : 0
    const total = current?.items.length ?? 0
    const maker = current?.createdBy ? sessionNames.get(current.createdBy) : undefined
    const pagerButton = 'w-6 h-6 shrink-0 flex items-center justify-center rounded text-gray-400 hover:bg-white/10 hover:text-gray-200 disabled:opacity-30 disabled:hover:bg-transparent'

    return (
        <div
            ref={ref}
            data-testid="checklist-panel"
            onKeyDown={panelKeys}
            tabIndex={-1}
            className="fixed z-[100] flex flex-col rounded-lg border border-white/10 bg-[#1e1e1e]/95 backdrop-blur shadow-2xl text-gray-200 outline-none"
            style={style}
        >
            {current && (
                <>
                    <div className="flex items-center gap-1 px-2 pt-2">
                        <button data-testid="checklist-prev" onClick={() => page(-1)} disabled={checklists.length < 2} className={pagerButton} title="Previous checklist (←)" aria-label="Previous checklist">
                            <ChevronLeft size={14} />
                        </button>
                        {editingTitle ? (
                            <input
                                data-testid="checklist-title-input"
                                autoFocus
                                value={titleDraft}
                                onChange={(e) => setTitleDraft(e.target.value)}
                                onBlur={commitTitle}
                                onKeyDown={(e) => {
                                    fieldKeys(e, () => setEditingTitle(false))
                                    if (e.key === 'Enter') e.currentTarget.blur()
                                }}
                                maxLength={200}
                                className="flex-1 min-w-0 bg-white/10 rounded px-1 text-[13px] font-semibold outline-none"
                            />
                        ) : (
                            <span
                                data-testid="checklist-title"
                                onDoubleClick={() => {
                                    setTitleDraft(current.title)
                                    setEditingTitle(true)
                                }}
                                title={`${current.title} — double-click to rename`}
                                className="flex-1 min-w-0 truncate text-[13px] font-semibold cursor-default"
                            >
                                {current.title}
                            </span>
                        )}
                        <span data-testid="checklist-position" className="shrink-0 text-[11px] text-gray-500 tabular-nums">{index + 1} / {checklists.length}</span>
                        <button data-testid="checklist-next" onClick={() => page(1)} disabled={checklists.length < 2} className={pagerButton} title="Next checklist (→)" aria-label="Next checklist">
                            <ChevronRight size={14} />
                        </button>
                        <button onClick={onClose} className={pagerButton} aria-label="Close checklists">
                            <X size={12} />
                        </button>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 px-3 pt-1 pb-2 text-[11px] text-gray-400">
                        <select
                            data-testid="checklist-project"
                            value={current.workspaceId ?? ''}
                            onChange={(e) => void window.api.updateChecklist(current.id, { workspaceId: e.target.value || null })}
                            onKeyDown={(e) => e.stopPropagation()}
                            className="max-w-[9rem] truncate bg-white/5 rounded px-1 py-0.5 outline-none [color-scheme:dark]"
                            title="Project"
                        >
                            <option value="">No project</option>
                            {workspaces.map((w) => (
                                <option key={w.id} value={w.id}>{w.name}</option>
                            ))}
                        </select>
                        <DueEditor
                            due={current.due}
                            todayKey={todayKey}
                            complete={total > 0 && done === total}
                            onSave={(due) => void window.api.updateChecklist(current.id, { due })}
                        />
                        {maker && <span data-testid="checklist-maker" className="truncate">by {maker}</span>}
                    </div>
                    <div className="h-[3px] mx-3 mb-1 rounded bg-white/10" title={`${done} of ${total} checked`}>
                        <div className="h-full rounded bg-emerald-500 transition-all" style={{ width: total ? `${(done / total) * 100}%` : 0 }} />
                    </div>
                    <ul data-testid="checklist-items" className="flex-1 min-h-0 overflow-y-auto py-1">
                        {current.items.length === 0 && (
                            <li className="px-3 py-2 text-[11px] text-gray-500">No items yet — add one below.</li>
                        )}
                        {current.items.map((item) => (
                            <ChecklistItemRow key={item.id} checklistId={current.id} item={item} />
                        ))}
                    </ul>
                    <form onSubmit={addItem} className="flex items-center gap-1.5 mx-2 mt-1 px-2 h-7 rounded bg-white/5">
                        <input
                            ref={addRef}
                            data-testid="checklist-add-input"
                            value={itemDraft}
                            onChange={(e) => setItemDraft(e.target.value)}
                            onKeyDown={(e) => fieldKeys(e, onClose)}
                            placeholder="Add an item…"
                            maxLength={200}
                            spellCheck={false}
                            className="flex-1 min-w-0 bg-transparent text-xs placeholder-gray-600 outline-none"
                        />
                        <button type="submit" disabled={!itemDraft.trim()} className="shrink-0 text-gray-400 hover:text-gray-200 disabled:opacity-30" aria-label="Add item">
                            <Plus size={14} />
                        </button>
                    </form>
                </>
            )}
            {showNewForm ? (
                <form onSubmit={createChecklist} className="flex items-center gap-1.5 m-2 px-2 h-7 rounded bg-white/5 border border-sky-500/30">
                    <input
                        ref={newRef}
                        data-testid="checklist-new-input"
                        autoFocus={creating}
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                        onKeyDown={(e) => fieldKeys(e, () => (checklists.length > 0 ? setCreating(false) : onClose()))}
                        placeholder="New checklist title…"
                        maxLength={200}
                        spellCheck={false}
                        className="flex-1 min-w-0 bg-transparent text-xs placeholder-gray-500 outline-none"
                    />
                    <button type="submit" disabled={!newTitle.trim()} className="shrink-0 text-[11px] text-sky-300 disabled:opacity-30">Create</button>
                </form>
            ) : (
                <div className="flex items-center justify-between px-3 py-2 text-[11px] text-gray-500">
                    <button data-testid="checklist-new" onClick={() => setCreating(true)} className="hover:text-gray-300">+ New checklist</button>
                    <button
                        data-testid="checklist-delete"
                        data-state={confirmDelete ? 'confirm' : 'idle'}
                        onClick={remove}
                        className={`flex items-center gap-1 ${confirmDelete ? 'text-red-300' : 'hover:text-red-300'}`}
                        title="Delete this checklist"
                    >
                        <Trash2 size={11} />
                        {confirmDelete ? 'Click again to delete' : 'Delete'}
                    </button>
                </div>
            )}
        </div>
    )
}
