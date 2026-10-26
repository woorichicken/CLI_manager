import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronsDownUp, ChevronsUpDown, FolderPlus, MoreHorizontal } from 'lucide-react'
import { MENU_Z_INDEX } from '../../constants/styles'

const MENU_GAP_PX = 4
const VIEWPORT_MARGIN_PX = 8
const MENU_WIDTH_PX = 176

interface SidebarMoreMenuProps {
    /** Some folder, workspace or session list is open: the item collapses; otherwise it expands. */
    anyExpanded: boolean
    onToggleCollapseAll: () => void
    onNewFolder: () => void
    /**
     * Which folders the items act on. The folder view's are workspace folders; the All sessions
     * view's are session folders, so the menu follows the view (reports afbc3546, 078ee766).
     */
    folderKind?: 'workspace' | 'session'
    /** Hide "Collapse/Expand All" when there is nothing it could fold. */
    showCollapseAll?: boolean
}

/**
 * Sidebar header "…" menu for the buttons used least (collapse all, new folder).
 * Folding them keeps the header at the button count it had before the inbox
 * bell, so the "Workspaces" title is not cut at the default width.
 */
export function SidebarMoreMenu({ anyExpanded, onToggleCollapseAll, onNewFolder, folderKind = 'workspace', showCollapseAll = true }: SidebarMoreMenuProps) {
    const sessionFolders = folderKind === 'session'
    const buttonRef = useRef<HTMLButtonElement>(null)
    const menuRef = useRef<HTMLDivElement>(null)
    const [position, setPosition] = useState<{ top: number; left: number } | null>(null)

    const close = useCallback(() => setPosition(null), [])
    const toggle = (): void => {
        if (position) return close()
        const rect = buttonRef.current?.getBoundingClientRect()
        if (!rect) return
        const left = Math.min(Math.max(rect.left, VIEWPORT_MARGIN_PX), window.innerWidth - MENU_WIDTH_PX - VIEWPORT_MARGIN_PX)
        setPosition({ top: rect.bottom + MENU_GAP_PX, left })
    }

    useEffect(() => {
        if (!position) return
        const onPointerDown = (e: PointerEvent): void => {
            const target = e.target as Node | null
            if (menuRef.current?.contains(target) || buttonRef.current?.contains(target)) return
            close()
        }
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') close()
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKey)
        }
    }, [position, close])

    const run = (action: () => void) => (): void => {
        close()
        action()
    }

    const itemClass =
        'w-full text-left px-2.5 py-1.5 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition-colors flex items-center gap-2'

    return (
        <>
            <button
                ref={buttonRef}
                data-testid="sidebar-more"
                onClick={toggle}
                className={`p-1 hover:bg-white/10 rounded transition-colors ${position ? 'bg-white/10' : ''}`}
                title="More"
            >
                <MoreHorizontal size={14} className="text-gray-400" />
            </button>
            {position &&
                createPortal(
                    <div
                        ref={menuRef}
                        data-testid="sidebar-more-menu"
                        className="fixed bg-[#1e1e20] border border-white/10 rounded shadow-xl py-0.5 backdrop-blur-md"
                        style={{ top: position.top, left: position.left, width: MENU_WIDTH_PX, zIndex: MENU_Z_INDEX }}
                    >
                        {showCollapseAll && (
                            <button
                                data-testid={sessionFolders ? 'sidebar-collapse-session-folders' : 'sidebar-collapse-all'}
                                data-state={anyExpanded ? 'expanded' : 'collapsed'}
                                className={itemClass}
                                onClick={run(onToggleCollapseAll)}
                            >
                                {anyExpanded
                                    ? <ChevronsDownUp size={12} className="text-gray-400 shrink-0" />
                                    : <ChevronsUpDown size={12} className="text-gray-400 shrink-0" />}
                                <span className="truncate">{anyExpanded ? 'Collapse All' : 'Expand All'}</span>
                            </button>
                        )}
                        <button
                            data-testid={sessionFolders ? 'sidebar-new-session-folder' : 'sidebar-new-folder'}
                            className={itemClass}
                            onClick={run(onNewFolder)}
                        >
                            <FolderPlus size={12} className="text-gray-400 shrink-0" />
                            <span className="truncate">{sessionFolders ? 'New Session Folder' : 'New Folder'}</span>
                        </button>
                    </div>,
                    document.body
                )}
        </>
    )
}
