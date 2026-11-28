import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListChecks } from 'lucide-react'
import type { Workspace } from '../../../../shared/types'
import { useCurrentChecklist } from '../../hooks/useChecklists'
import { describeDue, localDateKey, type DueTone } from '../../utils/dueDate'
import { ChecklistPanel } from './ChecklistPanel'
import { shortcutDescription, useShortcutHint } from '../../utils/shortcutHints'

interface HeaderChecklistsProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    /** Split view: the header is shorter. */
    compact: boolean
    /** the chip is turned off in Settings › Header buttons (d5efaf86): ⌘⇧J still opens the panel, at the header's right */
    hidden?: boolean
    workspaces: Workspace[]
    /** The project a new checklist starts with: the workspace of the session in view. */
    activeWorkspaceId?: string
    /** The session in view (the active pane in split view): its terminal gets focus when nothing else had it. */
    viewedSessionId: string | null
    /** Brings a session into view (the panel's "by <session>" line). */
    onShowSession?: (sessionId: string) => void
}

// Same lookup the memo uses to give focus back to its terminal.
function focusTerminal(sessionId: string): void {
    const textarea = document.querySelector(`[data-session-id="${sessionId}"] .xterm textarea`) as HTMLElement | null
    textarea?.focus()
}

const PANEL_WIDTH = 320
const VIEWPORT_MARGIN = 8
/** where the panel hangs from when the chip is hidden: just under the header row (h-12) */
const HIDDEN_CHIP_BOTTOM = 48
/** The deadline on the small chip is a dot in its tone (6ab4bf73); the label is in the tooltip and the panel. */
const DUE_DOT_CLASSES: Record<DueTone, string> = {
    overdue: 'bg-red-400',
    today: 'bg-amber-300',
    soon: 'bg-sky-300',
    later: 'bg-gray-400'
}

/**
 * The checklist chip in the main header and its panel. Checklists belong to no session,
 * so they sit in the one header every view shares (split view too), not in a terminal.
 * The panel is a portal like the inbox popover: the header is a window-drag region and
 * sits below the terminal's own overlays in stacking order.
 */
export function HeaderChecklists({ open, onOpenChange, compact, hidden = false, workspaces, activeWorkspaceId, viewedSessionId, onShowSession }: HeaderChecklistsProps) {
    const nav = useCurrentChecklist(activeWorkspaceId)
    const hint = useShortcutHint()
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

    // The key comes from Settings › Keyboard, like every other button's tooltip (386b0c76).
    // The checklist's own line comes first; what the key does goes last (78a79526).
    const label = hint('Checklists', 'toggleChecklists', false)
    const dueText = complete ? ' · done' : due ? ` · due ${due.label} (${current?.due})` : ''
    const tooltip = `${current
        ? `${label} — ${current.title} · ${done}/${total}${dueText}`
        : label}\n${shortcutDescription('toggleChecklists')}`

    const anchor = !open ? undefined : hidden ? { bottom: HIDDEN_CHIP_BOTTOM, right: window.innerWidth - VIEWPORT_MARGIN } : chipRef.current?.getBoundingClientRect()
    const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)

    return (
        <>
            <button
                ref={chipRef}
                // display: none, not the hidden attribute — the `flex` class would win over it
                style={hidden ? { display: 'none' } : undefined}
                data-testid="checklist-chip"
                data-checklist-id={current?.id ?? ''}
                data-progress={current ? `${done}/${total}` : ''}
                onClick={() => onOpenChange(!open)}
                title={tooltip}
                aria-label={current ? `Checklists — ${done} of ${total} done` : 'Checklists'}
                aria-expanded={open}
                className={`no-drag shrink-0 flex items-center gap-1 rounded-md border transition-colors ${
                    compact ? 'h-5 px-1 text-[10px]' : 'h-7 px-1.5 text-xs'
                } ${
                    open
                        ? 'bg-sky-500/25 border-sky-400/40 text-sky-100'
                        : current
                            ? 'bg-sky-500/10 border-sky-400/25 text-sky-200 hover:bg-sky-500/20'
                            : 'border-transparent text-gray-500 hover:bg-white/10 hover:text-gray-300'
                }`}
            >
                <ListChecks size={compact ? 12 : 14} />
                {/* A small button (6ab4bf73): the count at a glance, the deadline as a dot; the title and the
                    deadline's words are in the tooltip, and a click opens the panel with all of it. */}
                {current && (
                    <>
                        <span className={`tabular-nums ${complete ? 'text-emerald-300' : 'text-gray-300'}`}>{done}/{total}</span>
                        {!complete && due && (
                            <span
                                data-testid="checklist-chip-due"
                                data-due-tone={due.tone}
                                aria-label={`Due ${due.label}`}
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${DUE_DOT_CLASSES[due.tone]}`}
                            />
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
                        onShowSession={onShowSession}
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
