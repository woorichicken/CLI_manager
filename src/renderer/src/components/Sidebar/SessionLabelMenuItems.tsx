import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronRight, CircleDashed, Tag } from 'lucide-react'
import {
    SESSION_WORK_ROLES,
    SESSION_WORK_ROLE_HINTS,
    SESSION_WORK_ROLE_LABELS,
    type SessionWorkRole
} from '../../../../shared/sessionLabels'
import { MENU_Z_INDEX } from '../../constants/styles'
import { SessionRoleIcon } from './SessionRoleIcon'

/**
 * Marks a submenu that `useCloseOnOutside` treats as part of its menu. The submenu is portalled to
 * the body: inside the menu, its `backdrop-filter` would make the menu the containing block of a
 * fixed child and its `overflow-y: auto` would clip it.
 */
export const SUBMENU_ATTRIBUTE = 'data-sidebar-submenu'

const ROW = 'w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2'

interface SessionLabelMenuItemsProps {
    sessionId: string
    role?: SessionWorkRole
    tagCount: number
    /** `null` clears the role. */
    onSetRole: (role: SessionWorkRole | null) => void
    onEditLabels: () => void
    onClose: () => void
}

/**
 * The session menu's two label rows (decision 0015): `Role ▸` opens a submenu that saves on click,
 * `Edit Tags…` opens the editor. Shared by the sidebar row's menu and the tab's menu.
 */
export function SessionLabelMenuItems({ sessionId, role, tagCount, onSetRole, onEditLabels, onClose }: SessionLabelMenuItemsProps) {
    const rowRef = useRef<HTMLButtonElement>(null)
    const subRef = useRef<HTMLDivElement>(null)
    const [subOpen, setSubOpen] = useState(false)
    const [subPos, setSubPos] = useState<{ left: number; top: number } | null>(null)

    useLayoutEffect(() => {
        if (!subOpen || !rowRef.current) return
        const row = rowRef.current.getBoundingClientRect()
        const menu = rowRef.current.closest('[data-sidebar-menu]')?.getBoundingClientRect() ?? row
        const width = subRef.current?.offsetWidth ?? 140
        const height = subRef.current?.offsetHeight ?? 160
        const margin = 8
        // Beside the menu, flipped to its left when the window's edge is near.
        const right = menu.right + 2
        const left = right + width + margin > window.innerWidth ? Math.max(margin, menu.left - width - 2) : right
        const top = Math.max(margin, Math.min(row.top - 4, window.innerHeight - height - margin))
        setSubPos({ left, top })
    }, [subOpen])

    // Pointing at another row of the menu closes the submenu, like a native menu.
    useLayoutEffect(() => {
        const menu = rowRef.current?.closest('[data-sidebar-menu]')
        if (!subOpen || !menu) return
        const onOver = (e: Event): void => {
            if (!rowRef.current?.contains(e.target as Node)) setSubOpen(false)
        }
        menu.addEventListener('mouseover', onOver)
        return () => menu.removeEventListener('mouseover', onOver)
    }, [subOpen])

    const choose = (next: SessionWorkRole | null): void => {
        onSetRole(next)
        onClose()
    }

    return (
        <>
            <button
                ref={rowRef}
                data-testid="session-menu-role"
                aria-haspopup="menu"
                aria-expanded={subOpen}
                className={`${ROW} ${subOpen ? 'bg-white/10 text-white' : ''}`}
                onMouseEnter={() => setSubOpen(true)}
                // Opens, never toggles: pointing at the row already opened it, and the click that follows
                // must not close it again. Keyboard users get here by click alone.
                onClick={() => setSubOpen(true)}
                title="What this session is for — shown as the row's icon"
            >
                {role ? <SessionRoleIcon role={role} size={12} /> : <CircleDashed size={12} className="text-gray-400 shrink-0" />}
                <span className="flex-1 truncate">Role</span>
                <span className="text-[10px] text-gray-500">{role ? SESSION_WORK_ROLE_LABELS[role] : 'None'}</span>
                <ChevronRight size={10} className="text-gray-500 shrink-0" />
            </button>
            <button
                data-testid="session-menu-edit-tags"
                className={ROW}
                onMouseEnter={() => setSubOpen(false)}
                onClick={() => {
                    onEditLabels()
                    onClose()
                }}
                title="Role and tags — free words beside the name, such as the batch"
            >
                <Tag size={12} className="text-gray-400 shrink-0" />
                <span className="flex-1 truncate">Edit Tags…</span>
                {tagCount > 0 && <span className="text-[10px] text-gray-500">{tagCount}</span>}
            </button>
            {subOpen && createPortal(
                <div
                    ref={subRef}
                    role="menu"
                    {...{ [SUBMENU_ATTRIBUTE]: sessionId }}
                    data-testid="session-menu-role-submenu"
                    className="fixed bg-[#1e1e20] border border-white/10 rounded shadow-xl py-0.5 w-36"
                    style={{ zIndex: MENU_Z_INDEX + 1, left: subPos?.left ?? -9999, top: subPos?.top ?? -9999 }}
                    onClick={e => e.stopPropagation()}
                >
                    {SESSION_WORK_ROLES.map(option => (
                        <button
                            key={option}
                            role="menuitemradio"
                            aria-checked={role === option}
                            data-role-option={option}
                            className={`${ROW} ${role === option ? 'bg-white/10 text-white' : ''}`}
                            onClick={() => choose(option)}
                            title={SESSION_WORK_ROLE_HINTS[option]}
                        >
                            <SessionRoleIcon role={option} size={12} />
                            <span className="flex-1">{SESSION_WORK_ROLE_LABELS[option]}</span>
                            {role === option && <span aria-hidden>✓</span>}
                        </button>
                    ))}
                    <div className="border-t border-white/10 my-0.5" />
                    <button
                        role="menuitemradio"
                        aria-checked={!role}
                        data-role-option="none"
                        className={`${ROW} ${!role ? 'text-white' : ''}`}
                        onClick={() => choose(null)}
                    >
                        <span className="w-3 shrink-0" />
                        <span className="flex-1">None</span>
                        {!role && <span aria-hidden>✓</span>}
                    </button>
                </div>,
                document.body
            )}
        </>
    )
}
