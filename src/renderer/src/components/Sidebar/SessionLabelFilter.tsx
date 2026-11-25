import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ListFilter } from 'lucide-react'
import {
    SESSION_WORK_ROLES,
    SESSION_WORK_ROLE_LABELS,
    isSessionWorkRole,
    type SessionLabelFilter
} from '../../../../shared/sessionLabels'
import { MENU_Z_INDEX } from '../../constants/styles'
import { useCloseOnOutside } from './ContextMenus'
import { SessionRoleIcon } from './SessionRoleIcon'
import { SUBMENU_ATTRIBUTE } from './SessionLabelMenuItems'

const STORAGE_KEY = 'sidebar-session-label-filter'
/** Tags listed in the dropdown, most used first. */
const MAX_LISTED_TAGS = 12

function readFilter(): SessionLabelFilter {
    try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, unknown>
        return {
            role: isSessionWorkRole(saved.role) ? saved.role : null,
            tag: typeof saved.tag === 'string' && saved.tag ? saved.tag : null
        }
    } catch {
        return { role: null, tag: null }
    }
}

/**
 * The All sessions filter by role and tag (decision 0015). Kept on this Mac only (localStorage, like
 * the List/Tree choice) — never in the store, so it does not travel with the config.
 */
export function useSessionLabelFilter(): {
    filter: SessionLabelFilter
    active: boolean
    setFilter: (next: SessionLabelFilter) => void
} {
    const [filter, setFilterState] = useState<SessionLabelFilter>(readFilter)
    const setFilter = useCallback((next: SessionLabelFilter) => {
        setFilterState(next)
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ role: next.role ?? null, tag: next.tag ?? null }))
    }, [])
    return { filter, active: !!(filter.role || filter.tag), setFilter }
}

interface SessionLabelFilterButtonProps {
    filter: SessionLabelFilter
    active: boolean
    onChange: (next: SessionLabelFilter) => void
    /** Tags in use, most used first. */
    knownTags: string[]
}

const ROW = 'w-full text-left px-2.5 py-1 text-xs flex items-center gap-2 transition-colors hover:bg-white/10 hover:text-white'

/**
 * One icon button in the All sessions toolbar instead of a filter row — the reviewer found an extra
 * row made the narrow sidebar narrower (2026-11-25). A dot on it says a filter is on.
 */
export function SessionLabelFilterButton({ filter, active, onChange, knownTags }: SessionLabelFilterButtonProps) {
    const [open, setOpen] = useState(false)
    const buttonRef = useRef<HTMLButtonElement>(null)
    const label = [
        filter.role ? SESSION_WORK_ROLE_LABELS[filter.role] : '',
        filter.tag ? `#${filter.tag}` : ''
    ].filter(Boolean).join(' · ')

    return (
        <>
            <button
                ref={buttonRef}
                data-testid="all-sessions-label-filter"
                // Counted as part of its menu, so pressing it again closes the menu instead of reopening it.
                {...{ [SUBMENU_ATTRIBUTE]: 'label-filter' }}
                data-filter-active={active ? 'true' : undefined}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-label={active ? `Filter: ${label}` : 'Filter by role or tag'}
                onClick={() => setOpen(prev => !prev)}
                className={`relative shrink-0 flex items-center justify-center w-[26px] h-[22px] rounded border transition-colors ${
                    active || open ? 'border-blue-500/50 bg-blue-500/15 text-blue-200' : 'border-white/10 text-gray-400 hover:bg-white/5'
                }`}
                title={active ? `Showing ${label} — click to change` : 'Filter by role or tag'}
            >
                <ListFilter size={13} />
                {active && <span aria-hidden className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-blue-400" />}
            </button>
            {open && buttonRef.current && (
                <FilterMenu
                    anchor={buttonRef.current}
                    filter={filter}
                    knownTags={knownTags}
                    onChange={onChange}
                    onClose={() => setOpen(false)}
                />
            )}
        </>
    )
}

function FilterMenu({ anchor, filter, knownTags, onChange, onClose }: {
    anchor: HTMLElement
    filter: SessionLabelFilter
    knownTags: string[]
    onChange: (next: SessionLabelFilter) => void
    onClose: () => void
}) {
    const menuRef = useCloseOnOutside(onClose)
    useLayoutEffect(() => {
        const menu = menuRef.current
        if (!menu) return
        const box = anchor.getBoundingClientRect()
        const margin = 8
        menu.style.left = `${Math.max(margin, Math.min(box.left, window.innerWidth - menu.offsetWidth - margin))}px`
        menu.style.top = `${Math.min(box.bottom + 4, window.innerHeight - menu.offsetHeight - margin)}px`
    }, [anchor])
    // A tag the filter holds stays listed even when no session carries it any more, so it can be cleared.
    const tags = [...new Set([...(filter.tag ? [filter.tag] : []), ...knownTags])].slice(0, MAX_LISTED_TAGS)

    return createPortal(
        <div
            ref={menuRef}
            role="menu"
            data-sidebar-menu="label-filter"
            data-testid="all-sessions-label-filter-menu"
            className="fixed bg-[#1e1e20] border border-white/10 rounded shadow-xl py-1 w-44 max-h-[70vh] overflow-y-auto text-gray-300"
            style={{ zIndex: MENU_Z_INDEX }}
            onClick={e => e.stopPropagation()}
        >
            <div className="px-2.5 pt-0.5 pb-0.5 text-[10px] uppercase tracking-wide text-gray-500">Role</div>
            {SESSION_WORK_ROLES.map(role => (
                <button
                    key={role}
                    role="menuitemradio"
                    aria-checked={filter.role === role}
                    data-filter-role={role}
                    className={`${ROW} ${filter.role === role ? 'bg-white/10 text-white' : ''}`}
                    // Picking the role already picked turns that part of the filter off.
                    onClick={() => onChange({ ...filter, role: filter.role === role ? null : role })}
                >
                    <SessionRoleIcon role={role} size={12} />
                    <span className="flex-1">{SESSION_WORK_ROLE_LABELS[role]}</span>
                    {filter.role === role && <span aria-hidden>✓</span>}
                </button>
            ))}
            <div className="border-t border-white/10 my-1" />
            <div className="px-2.5 pt-0.5 pb-0.5 text-[10px] uppercase tracking-wide text-gray-500">Tag</div>
            {tags.length === 0 ? (
                <div className="px-2.5 py-1 text-[11px] text-gray-500">No tags yet — right-click a session › Edit Tags…</div>
            ) : tags.map(tag => {
                const picked = filter.tag?.toLowerCase() === tag.toLowerCase()
                return (
                    <button
                        key={tag}
                        role="menuitemradio"
                        aria-checked={picked}
                        data-filter-tag={tag}
                        className={`${ROW} ${picked ? 'bg-white/10 text-white' : ''}`}
                        onClick={() => onChange({ ...filter, tag: picked ? null : tag })}
                    >
                        <span className="w-3 text-center text-gray-500">#</span>
                        <span className="flex-1 truncate">{tag}</span>
                        {picked && <span aria-hidden>✓</span>}
                    </button>
                )
            })}
            <div className="border-t border-white/10 my-1" />
            <button
                data-filter-clear
                disabled={!filter.role && !filter.tag}
                className={`${ROW} disabled:text-gray-600 disabled:hover:bg-transparent`}
                onClick={() => {
                    onChange({ role: null, tag: null })
                    onClose()
                }}
            >
                Clear filter
            </button>
        </div>,
        document.body
    )
}
