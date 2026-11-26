import React, { useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Columns2, Pencil, Pin, PinOff, SquareX, Tag, Trash2, X } from 'lucide-react'
import { useCloseOnOutside } from '../Sidebar/ContextMenus'
import { requestEditSessionLabels } from '../Sidebar/SessionLabelsDialog'
import { MENU_Z_INDEX } from '../../constants/styles'
import { tabsToClose, type TabCloseScope } from '../../../../shared/sessionTabs'
import { useShortcutHint } from '../../utils/shortcutHints'

/** What the tab menu can do beyond the row itself — App owns split view and ending sessions. */
export interface SessionTabMenuActions {
    /** Closes these tabs (sessions keep running); `focusId` is shown if the one on screen goes. */
    onCloseMany: (ids: string[], focusId: string | null) => void
    /** Why the tab cannot go beside the screen, or null when it can (split view holds 4, already there…). */
    sideBySideBlocked: (id: string) => string | null
    onOpenSideBySide: (id: string) => void
    /** Ends the session, as ⌘W does for the one on screen (asks first while a process runs). */
    onEndSession: (id: string) => void
    /** A preview tab (the next session shown replaces it). Absent: no Keep Open item. */
    isPreview?: (id: string) => boolean
    /** Keeps a preview tab in the row. */
    onKeepOpen?: (id: string) => void
    /** A kept tab that can become a preview again: preview tabs are on and the tab is on screen. Absent: no Unpin item. */
    canMakePreview?: (id: string) => boolean
    /** Makes a kept tab a preview (the next session shown takes its place). */
    onMakePreview?: (id: string) => void
}

interface SessionTabMenuProps {
    x: number
    y: number
    tabId: string
    tabIds: string[]
    actions: SessionTabMenuActions
    onCloseTab: (id: string) => void
    /** Rename in place on the tab (13968765). Absent: no Rename item. */
    onRenameTab?: (id: string) => void
    onClose: () => void
}

const ITEM = 'w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent disabled:cursor-default'
/** Keeps the menu off the window edge; it opens under the pointer like the sidebar's. */
const EDGE_MARGIN_PX = 8

/** Right-click on a tab: the VS Code tab menu's close group, plus split view and ending the session. */
export function SessionTabMenu({ x, y, tabId, tabIds, actions, onCloseTab, onRenameTab, onClose }: SessionTabMenuProps): React.ReactElement {
    const menuRef = useCloseOnOutside(onClose)
    const hint = useShortcutHint()
    useLayoutEffect(() => {
        const menu = menuRef.current
        if (!menu) return
        const { width, height } = menu.getBoundingClientRect()
        menu.style.left = `${Math.max(EDGE_MARGIN_PX, Math.min(x, window.innerWidth - width - EDGE_MARGIN_PX))}px`
        menu.style.top = `${Math.max(EDGE_MARGIN_PX, Math.min(y, window.innerHeight - height - EDGE_MARGIN_PX))}px`
    }, [x, y])

    const run = (action: () => void) => (): void => {
        action()
        onClose()
    }
    const closeScope = (scope: TabCloseScope): void => {
        actions.onCloseMany(tabsToClose(tabIds, tabId, scope), scope === 'all' ? null : tabId)
    }
    const others = tabsToClose(tabIds, tabId, 'others').length
    const right = tabsToClose(tabIds, tabId, 'right').length
    const blocked = actions.sideBySideBlocked(tabId)

    return createPortal(
        <div
            ref={menuRef}
            data-session-tab-menu={tabId}
            role="menu"
            className="fixed bg-[#1e1e20] border border-white/10 rounded shadow-xl py-0.5 w-48 backdrop-blur-md"
            style={{ top: y, left: x, zIndex: MENU_Z_INDEX }}
            onClick={(event) => event.stopPropagation()}
        >
            {onRenameTab && (
                <>
                    <button className={ITEM} data-tab-menu-item="rename" title={hint('Rename the session', 'renameSession', false)} onClick={run(() => onRenameTab(tabId))}>
                        <Pencil size={12} className="text-gray-400 shrink-0" />
                        <span className="truncate">Rename…</span>
                    </button>
                    <button className={ITEM} data-tab-menu-item="labels" title="What the session is for (shown as its icon) and tags beside its name" onClick={run(() => requestEditSessionLabels(tabId))}>
                        <Tag size={12} className="text-gray-400 shrink-0" />
                        <span className="truncate">Role & Tags…</span>
                    </button>
                    <div className="border-t border-white/10 my-0.5" />
                </>
            )}
            {actions.isPreview?.(tabId) && actions.onKeepOpen && (
                <>
                    <button
                        className={ITEM}
                        data-tab-menu-item="keep-open"
                        title="Keep this tab — the next session you open gets a tab of its own"
                        onClick={run(() => actions.onKeepOpen?.(tabId))}
                    >
                        <Pin size={12} className="text-gray-400 shrink-0" />
                        <span className="truncate">Keep Open</span>
                    </button>
                    <div className="border-t border-white/10 my-0.5" />
                </>
            )}
            {actions.canMakePreview?.(tabId) && actions.onMakePreview && (
                <>
                    <button
                        className={ITEM}
                        data-tab-menu-item="make-preview"
                        title="Make this a preview tab again — the next session you open takes its place"
                        onClick={run(() => actions.onMakePreview?.(tabId))}
                    >
                        <PinOff size={12} className="text-gray-400 shrink-0" />
                        <span className="truncate">Unpin</span>
                    </button>
                    <div className="border-t border-white/10 my-0.5" />
                </>
            )}
            <button className={ITEM} data-tab-menu-item="close" title="Close the tab — the session keeps running" onClick={run(() => onCloseTab(tabId))}>
                <X size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Close Tab</span>
            </button>
            <button className={ITEM} data-tab-menu-item="close-others" disabled={others === 0} onClick={run(() => closeScope('others'))}>
                <SquareX size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Close Other Tabs</span>
            </button>
            <button className={ITEM} data-tab-menu-item="close-right" disabled={right === 0} onClick={run(() => closeScope('right'))}>
                <SquareX size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Close Tabs to the Right</span>
            </button>
            <button className={ITEM} data-tab-menu-item="close-all" onClick={run(() => closeScope('all'))}>
                <SquareX size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Close All Tabs</span>
            </button>
            <div className="border-t border-white/10 my-0.5" />
            <button
                className={ITEM}
                data-tab-menu-item="side-by-side"
                disabled={blocked !== null}
                title={blocked ?? 'Show it beside the session on screen (split view)'}
                onClick={run(() => actions.onOpenSideBySide(tabId))}
            >
                <Columns2 size={12} className="text-gray-400 shrink-0" />
                <span className="truncate">Open Side by Side</span>
            </button>
            <div className="border-t border-white/10 my-0.5" />
            <button
                className={`${ITEM} text-red-300 hover:bg-red-500/20 hover:text-red-200`}
                data-tab-menu-item="end-session"
                title={hint('End the session and close its tab', 'closeSession', false)}
                onClick={run(() => actions.onEndSession(tabId))}
            >
                <Trash2 size={12} className="text-red-400 shrink-0" />
                <span className="truncate">End Session</span>
            </button>
        </div>,
        document.body
    )
}
