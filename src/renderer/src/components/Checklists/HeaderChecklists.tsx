import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListChecks } from 'lucide-react'
import type { Workspace } from '../../../../shared/types'
import { useCurrentChecklist } from '../../hooks/useChecklists'
import { describeDue, DUE_TONE_CLASSES, localDateKey } from '../../utils/dueDate'
import { ChecklistPanel } from './ChecklistPanel'

interface HeaderChecklistsProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Split view: the header is shorter. */
    compact: boolean
    workspaces: Workspace[]
    /** The project a new checklist starts with: the workspace of the session in view. */
    activeWorkspaceId?: string
    /** The session in view (the active pane in split view): its terminal gets focus when nothing else had it. */
    viewedSessionId: string | null
}

// Same lookup the memo uses to give focus back to its terminal.
function focusTerminal(sessionId: string): void {
    const textarea = document.querySelector(`[data-session-id="${sessionId}"] .xterm textarea`) as HTMLElement | null
    textarea?.focus()
}

const PANEL_WIDTH = 320
const VIEWPORT_MARGIN = 8

/**
 * The checklist chip in the main header and its panel. Checklists belong to no session,
 * so they sit in the one header every view shares (split view too), not in a terminal.
 * The panel is a portal like the inbox popover: the header is a window-drag region and
 * sits below the terminal's own overlays in stacking order.
 */
export function HeaderChecklists({ open, onOpenChange, compact, workspaces, activeWorkspaceId, viewedSessionId }: HeaderChecklistsProps) {
    const nav = useCurrentChecklist()
    const { current } = nav
    const chipRef = useRef<HTMLButtonElement>(null)
    // What had focus when the panel opened (usually the terminal) gets it back when the panel closes
    // and takes the focused field with it (Esc, ⌘⇧J). A click elsewhere already put focus there.
    // When nothing had focus (right after launch the page body does), the terminal in view gets it —
    // otherwise typing after Esc goes nowhere.
    const returnFocusRef = useRef<HTMLElement | null>(null)
    const viewedSessionRef = useRef(viewedSessionId)
    viewedSessionRef.current = viewedSessionId
    const [, setViewport] = useState(0)

    useEffect(() => {
        if (!open) return
        returnFocusRef.current = document.activeElement as HTMLElement | null
        const onResize = (): void => setViewport((n) => n + 1)
        window.addEventListener('resize', onResize)
        return () => {
            window.removeEventListener('resize', onResize)
            const previous = returnFocusRef.current
            setTimeout(() => {
                if (document.activeElement && document.activeElement !== document.body) return
                if (previous && previous !== document.body && previous.isConnected) previous.focus()
                else if (viewedSessionRef.current) focusTerminal(viewedSessionRef.current)
            }, 0)
        }
    }, [open])

    const close = (): void => onOpenChange(false)

    const todayKey = localDateKey()
    const done = current ? current.items.filter((i) => i.doneAt !== undefined).length : 0
    const total = current?.items.length ?? 0
    const complete = total > 0 && done === total
    const due = current?.due ? describeDue(current.due, todayKey) : null

    const tooltip = current
        ? `Checklists (⌘⇧J) — ${current.title} · ${done}/${total}${current.due ? ` · due ${current.due}` : ''}`
        : 'Checklists (⌘⇧J)'

    const anchor = open ? chipRef.current?.getBoundingClientRect() : undefined
    const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)

    return (
        <>
            <button
                ref={chipRef}
                data-testid="checklist-chip"
                data-checklist-id={current?.id ?? ''}
                data-progress={current ? `${done}/${total}` : ''}
                onClick={() => onOpenChange(!open)}
                title={tooltip}
                aria-label="Checklists"
                aria-expanded={open}
                className={`no-drag shrink-0 flex items-center gap-1.5 rounded-md border transition-colors ${
                    compact ? 'h-5 px-1 text-[10px]' : 'h-7 px-2 text-xs'
                } ${
                    open
                        ? 'bg-sky-500/25 border-sky-400/40 text-sky-100'
                        : current
                            ? 'bg-sky-500/10 border-sky-400/25 text-sky-200 hover:bg-sky-500/20'
                            : 'border-transparent text-gray-500 hover:bg-white/10 hover:text-gray-300'
                }`}
            >
                <ListChecks size={compact ? 12 : 14} />
                {current && (
                    <>
                        {/* The title goes first when the window is narrow: the progress is what matters at a glance. */}
                        <span data-testid="checklist-chip-title" className="hidden sm:inline max-w-[10rem] truncate">{current.title}</span>
                        <span className="tabular-nums text-gray-400">{done}/{total}</span>
                        {complete ? (
                            <span className="px-1 rounded border text-[10px] leading-4 text-emerald-300 bg-emerald-500/10 border-emerald-500/30">Done</span>
                        ) : (
                            due && (
                                <span data-testid="checklist-chip-due" data-due-tone={due.tone} className={`hidden sm:inline px-1 rounded border text-[10px] leading-4 ${DUE_TONE_CLASSES[due.tone]}`}>
                                    {due.label}
                                </span>
                            )
                        )}
                    </>
                )}
            </button>
            {open && anchor &&
                createPortal(
                    <ChecklistPanel
                        nav={nav}
                        workspaces={workspaces}
                        activeWorkspaceId={activeWorkspaceId}
                        todayKey={todayKey}
                        onClose={close}
                        style={{
                            top: anchor.bottom + 4,
                            left: Math.min(Math.max(anchor.right - width, VIEWPORT_MARGIN), window.innerWidth - width - VIEWPORT_MARGIN),
                            width,
                            maxHeight: Math.max(200, window.innerHeight - anchor.bottom - 4 - VIEWPORT_MARGIN)
                        }}
                    />,
                    document.body
                )}
        </>
    )
}
