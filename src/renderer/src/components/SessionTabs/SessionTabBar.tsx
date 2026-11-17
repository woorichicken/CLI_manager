import React, { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useSessionScreenStatus } from '../../hooks/useSessionScreenStatus'
import { SCREEN_STATUS_COLORS } from '../Sidebar/SessionItem'
import { SessionTabMenu, type SessionTabMenuActions } from './SessionTabMenu'

export interface SessionTabEntry {
    id: string
    name: string
    /** The workspace name, shown in the tooltip — tabs from different projects can share a name. */
    workspaceName: string
}

interface SessionTabBarProps {
    tabs: SessionTabEntry[]
    /** The tab on screen: the active session, or the focused split pane. */
    activeId: string | null
    /** Sessions shown in split view panes — marked so the person sees which tabs are on screen. */
    visibleIds: string[]
    onSelect: (id: string) => void
    onClose: (id: string) => void
    onMove: (id: string, toIndex: number) => void
    /** Right-click menu. Without it a right-click does nothing (no browser menu either). */
    menu?: SessionTabMenuActions
    /** Split view: the header above shrinks to h-6, and the row follows. */
    compact?: boolean
}

/** VS Code 「shrink」 sizing: name width up to 200px, giving way to 80px before the row scrolls. */
const TAB_WIDTH = 'flex-[0_1_auto] min-w-[80px] max-w-[200px]'

/** A drag in this row carries this type, so a tab is not mistaken for a sidebar row dropped on split view. */
const TAB_DRAG_TYPE = 'application/x-climanager-tab'

/**
 * The tab row under the main header, over the terminals. Tabs shrink as more open (VS Code's
 * 「shrink」 sizing): each keeps its name width up to 200px and gives way down to 80px, after
 * which the row scrolls sideways and the tab on screen is scrolled into view.
 */
export function SessionTabBar({ tabs, activeId, visibleIds, onSelect, onClose, onMove, menu, compact = false }: SessionTabBarProps): React.ReactElement | null {
    const rowRef = useRef<HTMLDivElement>(null)
    const [dropIndex, setDropIndexState] = useState<number | null>(null)
    // The drop reads the ref: dragover and drop can come before a render in between.
    const dropIndexRef = useRef<number | null>(null)
    const setDropIndex = (index: number | null): void => { dropIndexRef.current = index; setDropIndexState(index) }
    const draggingRef = useRef<string | null>(null)
    const [menuAt, setMenuAt] = useState<{ id: string; x: number; y: number } | null>(null)

    // The tab on screen stays in view when the row overflows — also when the window narrows.
    useEffect(() => {
        const row = rowRef.current
        if (!activeId || !row) return
        const reveal = (): void => {
            row.querySelector<HTMLElement>(`[data-session-tab="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        }
        reveal()
        const observer = new ResizeObserver(reveal)
        observer.observe(row)
        return () => observer.disconnect()
    }, [activeId, tabs.length])

    const dropAt = (event: React.DragEvent, index: number): void => {
        if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
        event.preventDefault()
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
        setDropIndex(event.clientX < rect.left + rect.width / 2 ? index : index + 1)
    }

    const finishDrop = (event: React.DragEvent): void => {
        const id = draggingRef.current
        const target = dropIndexRef.current
        draggingRef.current = null
        setDropIndex(null)
        if (!id || target === null || !event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
        event.preventDefault()
        const from = tabs.findIndex((tab) => tab.id === id)
        // Dropping after its own place moves it one less, since it leaves its slot first.
        onMove(id, from >= 0 && from < target ? target - 1 : target)
    }

    return (
        <div
            ref={rowRef}
            data-testid="session-tab-bar"
            role="tablist"
            aria-label="Open sessions"
            className={`${compact ? 'h-6' : 'h-9'} shrink-0 border-b border-white/10 flex items-stretch overflow-x-auto overflow-y-hidden session-tab-bar transition-all`}
            // No scrollbar: it would take height from the row; the wheel and the active-tab reveal still scroll it.
            style={{ scrollbarWidth: 'none' }}
            onWheel={(event) => { if (event.deltaY && !event.deltaX) rowRef.current?.scrollBy({ left: event.deltaY }) }}
            onDragOver={(event) => { if (event.dataTransfer.types.includes(TAB_DRAG_TYPE)) event.preventDefault() }}
            onDrop={finishDrop}
        >
            {tabs.map((tab, index) => (
                <SessionTab
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeId}
                    visible={visibleIds.includes(tab.id)}
                    dropBefore={dropIndex === index}
                    dropAfter={dropIndex === tabs.length && index === tabs.length - 1}
                    onSelect={onSelect}
                    onClose={onClose}
                    onDragStart={(event) => {
                        draggingRef.current = tab.id
                        event.dataTransfer.setData(TAB_DRAG_TYPE, tab.id)
                        event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(event) => dropAt(event, index)}
                    onDragEnd={() => { draggingRef.current = null; setDropIndex(null) }}
                    onContextMenu={(event) => {
                        event.preventDefault()
                        if (menu) setMenuAt({ id: tab.id, x: event.clientX, y: event.clientY })
                    }}
                />
            ))}
            {/* Tabs take what they need; the rest of the row stays empty. */}
            <div className="flex-1 min-w-4" />
            {menu && menuAt && tabs.some((tab) => tab.id === menuAt.id) && (
                <SessionTabMenu
                    x={menuAt.x}
                    y={menuAt.y}
                    tabId={menuAt.id}
                    tabIds={tabs.map((tab) => tab.id)}
                    actions={menu}
                    onCloseTab={onClose}
                    onClose={() => setMenuAt(null)}
                />
            )}
        </div>
    )
}

interface SessionTabProps {
    tab: SessionTabEntry
    active: boolean
    visible: boolean
    dropBefore: boolean
    dropAfter: boolean
    onSelect: (id: string) => void
    onClose: (id: string) => void
    onDragStart: (event: React.DragEvent) => void
    onDragOver: (event: React.DragEvent) => void
    onDragEnd: () => void
    onContextMenu: (event: React.MouseEvent) => void
}

function SessionTab({ tab, active, visible, dropBefore, dropAfter, onSelect, onClose, onDragStart, onDragOver, onDragEnd, onContextMenu }: SessionTabProps): React.ReactElement {
    const screenStatus = useSessionScreenStatus(tab.id)
    const status = screenStatus.enabled ? screenStatus.status : null
    const dot = status && status.state !== 'idle' && !active ? status : null

    return (
        <div
            data-session-tab={tab.id}
            data-active={active ? 'true' : undefined}
            data-visible={visible ? 'true' : undefined}
            role="tab"
            aria-selected={active}
            title={`${tab.name} — ${tab.workspaceName}`}
            draggable
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={onDragEnd}
            onContextMenu={onContextMenu}
            onClick={() => onSelect(tab.id)}
            // Middle click closes, as in a browser or VS Code.
            onAuxClick={(event) => { if (event.button === 1) { event.preventDefault(); onClose(tab.id) } }}
            onMouseDown={(event) => { if (event.button === 1) event.preventDefault() }}
            className={`group relative no-drag flex items-center gap-1.5 pl-3 pr-1.5 ${TAB_WIDTH} cursor-pointer select-none border-r border-white/10 text-xs transition-colors ${
                active
                    ? 'bg-white/10 text-white'
                    : visible
                        ? 'bg-white/[0.04] text-gray-300 hover:bg-white/[0.07]'
                        : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`}
        >
            {active && <span className="absolute left-0 right-0 top-0 h-0.5 bg-blue-400" aria-hidden />}
            {dropBefore && <span className="absolute left-0 top-1 bottom-1 w-0.5 bg-blue-400" aria-hidden />}
            {dropAfter && <span className="absolute right-0 top-1 bottom-1 w-0.5 bg-blue-400" aria-hidden />}
            {dot && (
                <span
                    data-session-tab-status={dot.state}
                    className={`w-2 h-2 rounded-full shrink-0 ${SCREEN_STATUS_COLORS[dot.state as keyof typeof SCREEN_STATUS_COLORS] ?? ''}`}
                    title={dot.state === 'waiting' ? `Waiting for you${dot.question ? ` — ${dot.question}` : ''}` : 'Working'}
                />
            )}
            <span className="truncate flex-1 min-w-0" data-session-tab-name>{tab.name}</span>
            <button
                type="button"
                data-session-tab-close={tab.id}
                aria-label={`Close tab ${tab.name}`}
                title="Close tab (the session keeps running)"
                onClick={(event) => { event.stopPropagation(); onClose(tab.id) }}
                className={`p-0.5 rounded hover:bg-white/15 text-gray-400 hover:text-white shrink-0 ${active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'}`}
            >
                <X size={12} />
            </button>
        </div>
    )
}
