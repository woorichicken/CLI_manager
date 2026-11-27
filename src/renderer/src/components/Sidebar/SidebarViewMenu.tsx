import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type React from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { MENU_Z_INDEX } from '../../constants/styles'

/** What the sidebar shows: the workspace folders, or every session as a list or a tree. */
export type SidebarView = 'folders' | 'list' | 'tree'

const VIEW_LABELS: Record<SidebarView, string> = {
    folders: 'Folders',
    list: 'List',
    tree: 'Tree'
}

const VIEW_HINTS: Record<SidebarView, string> = {
    folders: 'Sessions under their workspace folders',
    list: 'Every session, by session folder',
    tree: 'Each session under the session that opened it'
}

interface SidebarViewMenuProps {
    view: SidebarView
    /** False when Settings › Sidebar › Show Session Tree is off: no Tree option. */
    showTree: boolean
    /** Dimmed while the Threads list replaces the sessions (like List / Tree were). */
    dimmed?: boolean
    onChoose: (view: SidebarView) => void
}

const ROW = 'w-full text-left px-2.5 py-1 text-xs flex items-center gap-2 transition-colors hover:bg-white/10 hover:text-white focus:bg-white/10 focus:text-white outline-none'

/**
 * View ▾ at the left of the sidebar toolbar: one dropdown for Folders · List · Tree. It replaced the
 * header's view toggle and the List / Tree buttons (view-filter-1127, person 11-27). The chip names the
 * current view, which the header title cannot at the default width on macOS (SidebarTitle).
 */
export function SidebarViewMenu({ view, showTree, dimmed, onChoose }: SidebarViewMenuProps) {
    const [open, setOpen] = useState(false)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const views: SidebarView[] = showTree ? ['folders', 'list', 'tree'] : ['folders', 'list']

    const close = (refocus: boolean): void => {
        setOpen(false)
        if (refocus) buttonRef.current?.focus()
    }

    return (
        <>
            <button
                ref={buttonRef}
                data-testid="sidebar-view-menu"
                data-view={view}
                data-dimmed={dimmed ? 'true' : undefined}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={`View: ${VIEW_LABELS[view]}`}
                onClick={() => setOpen(prev => !prev)}
                className={`shrink-0 flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border transition-colors ${
                    open ? 'border-blue-500/50 bg-blue-500/15 text-blue-200' : 'border-white/10 text-gray-300 hover:bg-white/5'
                } ${dimmed ? 'opacity-50' : ''}`}
                title={`View: ${VIEW_LABELS[view]} — ${VIEW_HINTS[view]}`}
            >
                <span>{VIEW_LABELS[view]}</span>
                <ChevronDown size={11} className="text-gray-500" />
            </button>
            {open && buttonRef.current && (
                <ViewMenu
                    anchor={buttonRef.current}
                    chip={buttonRef.current}
                    view={view}
                    views={views}
                    onChoose={next => {
                        close(true)
                        onChoose(next)
                    }}
                    onClose={close}
                />
            )}
        </>
    )
}

function ViewMenu({ anchor, chip, view, views, onChoose, onClose }: {
    anchor: HTMLElement
    /** Its own chip: a press there toggles the menu (the chip's onClick), so it does not count as outside. */
    chip: HTMLElement
    view: SidebarView
    views: SidebarView[]
    onChoose: (view: SidebarView) => void
    onClose: (refocus: boolean) => void
}) {
    // Not useCloseOnOutside: that treats every submenu-marked button as inside, so the role/tag filter's
    // button next to this one would open its menu over this one (and this chip over that one) — codex review
    // of view-filter-1127. Here only this menu and its own chip are inside. Esc gives focus back to the chip;
    // a press elsewhere leaves focus where the press put it.
    const menuRef = useRef<HTMLDivElement>(null)
    const closeRef = useRef(onClose)
    closeRef.current = onClose
    useEffect(() => {
        const onPointerDown = (e: PointerEvent): void => {
            const target = e.target as Node
            if (menuRef.current?.contains(target) || chip.contains(target)) return
            closeRef.current(false)
        }
        const onKeyDown = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return
            // Kept from the terminal behind the menu: Esc there would interrupt the agent.
            e.preventDefault()
            e.stopPropagation()
            closeRef.current(true)
        }
        window.addEventListener('pointerdown', onPointerDown, true)
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
            window.removeEventListener('pointerdown', onPointerDown, true)
            window.removeEventListener('keydown', onKeyDown, true)
        }
    }, [chip])
    useLayoutEffect(() => {
        const menu = menuRef.current
        if (!menu) return
        const box = anchor.getBoundingClientRect()
        const margin = 8
        menu.style.left = `${Math.max(margin, Math.min(box.left, window.innerWidth - menu.offsetWidth - margin))}px`
        menu.style.top = `${Math.min(box.bottom + 4, window.innerHeight - menu.offsetHeight - margin)}px`
        // Start on the current view so ↑/↓ move from where the user is.
        menu.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    }, [anchor])

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
        const step = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0
        const jump = e.key === 'Home' ? 'first' : e.key === 'End' ? 'last' : null
        if (!step && !jump) return
        e.preventDefault()
        const options = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[data-view-option]') ?? [])
        if (options.length === 0) return
        const at = options.indexOf(document.activeElement as HTMLElement)
        const next = jump === 'first' ? 0
            : jump === 'last' ? options.length - 1
            : (at + step + options.length) % options.length
        options[next].focus()
    }

    return createPortal(
        <div
            ref={menuRef}
            role="menu"
            aria-label="View"
            data-sidebar-menu="view"
            data-testid="sidebar-view-menu-list"
            className="fixed bg-[#1e1e20] border border-white/10 rounded shadow-xl py-1 w-44 text-gray-300"
            style={{ zIndex: MENU_Z_INDEX }}
            onClick={e => e.stopPropagation()}
            onKeyDown={onKeyDown}
        >
            <div className="px-2.5 pt-0.5 pb-0.5 text-[10px] uppercase tracking-wide text-gray-500">View</div>
            {views.map(option => (
                <button
                    key={option}
                    role="menuitemradio"
                    aria-checked={view === option}
                    data-view-option={option}
                    className={`${ROW} ${view === option ? 'bg-white/10 text-white' : ''}`}
                    title={VIEW_HINTS[option]}
                    onClick={() => onChoose(option)}
                >
                    <span className="flex-1">{VIEW_LABELS[option]}</span>
                    {view === option && <span aria-hidden>✓</span>}
                </button>
            ))}
        </div>,
        document.body
    )
}
