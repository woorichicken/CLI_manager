import { useRef } from 'react'
import { ChevronRight, Globe, X } from 'lucide-react'
import type { DocPane } from '../../utils/docPanes'
import { HtmlDocView, type DocLeaveGuard } from './HtmlDocView'

interface DocSplitPaneProps {
    paneId: string
    pane: DocPane
    isActive: boolean
    /** the split's header shape (wide rows when every pane is wide), so this header lines up with the sessions' */
    wide: boolean
    className?: string
    onActivate: () => void
    onSetSource: (source: boolean) => void
    onNavigate: (path: string) => void
    onClose: () => void
}

/**
 * A document in split view (backlog 「앱 안 브라우저」 B): the same header place as a session's pane — the path, then
 * Preview/Source · Browser · close — and the page in the sandboxed frame below (decision 0013).
 */
export function DocSplitPane({ paneId, pane, isActive, wide, className = '', onActivate, onSetSource, onNavigate, onClose }: DocSplitPaneProps) {
    // typed and not copied in the page: closing this pane asks first (ec4c1682)
    const leaveGuard: DocLeaveGuard = useRef(null)
    const parts = pane.path.split('/').filter(Boolean)
    const name = parts.pop() ?? pane.path
    const folders = parts.slice(-2)
    const segment = (source: boolean, label: string, testId: string) => (
        <button
            type="button"
            aria-pressed={pane.source === source}
            data-testid={testId}
            onClick={(event) => {
                event.stopPropagation()
                onSetSource(source)
            }}
            className={`px-2 py-0.5 transition-colors ${pane.source === source ? 'bg-white/15 text-white' : 'text-gray-400 hover:text-white'}`}
        >
            {label}
        </button>
    )
    return (
        <div
            className={`flex flex-col overflow-hidden pointer-events-auto bg-[#121216] outline-none ${className}`}
            data-doc-pane={paneId}
            data-path={pane.path}
            tabIndex={-1}
            onMouseDown={onActivate}
            onFocus={onActivate}
        >
            <div
                data-pane-header={paneId}
                className={`pane-header ${wide ? 'h-10 pl-3 pr-4 gap-2' : 'h-8 px-2 gap-1'} flex items-center border-b shrink-0 transition-colors ${
                    isActive ? 'bg-blue-500/10 border-blue-500/30' : 'bg-black/30 border-white/10'
                }`}
            >
                <div className="flex items-center gap-1 min-w-0 flex-1 text-xs text-gray-400" title={pane.path}>
                    {folders.map((folder, index) => (
                        <span key={`${folder}-${index}`} className="flex items-center gap-1 min-w-0 shrink">
                            <span className="truncate">{folder}</span>
                            <ChevronRight size={11} className="shrink-0 text-gray-600" />
                        </span>
                    ))}
                    <Globe size={12} className="shrink-0 text-sky-400" />
                    <span className="truncate text-gray-200">{name}</span>
                    {pane.line !== undefined && <span className="shrink-0 text-gray-500">:{pane.line}</span>}
                </div>
                <div className="flex items-center rounded border border-white/10 overflow-hidden text-[11px] shrink-0" role="group" aria-label="Preview or source">
                    {segment(false, 'Preview', 'doc-pane-preview')}
                    {segment(true, 'Source', 'doc-pane-source')}
                </div>
                <button
                    type="button"
                    data-testid="doc-pane-browser"
                    onClick={(event) => {
                        event.stopPropagation()
                        void window.api.openChatPath(pane.path, pane.sessionId)
                    }}
                    className="p-1 shrink-0 hover:bg-white/10 rounded transition-colors text-gray-400 hover:text-white"
                    title="Open in browser"
                >
                    <Globe size={wide ? 16 : 14} />
                </button>
                <button
                    type="button"
                    data-testid="doc-pane-close"
                    onClick={(event) => {
                        event.stopPropagation()
                        if (leaveGuard.current) leaveGuard.current(onClose)
                        else onClose()
                    }}
                    className="p-1 shrink-0 hover:bg-red-500/20 rounded transition-colors text-gray-400 hover:text-red-400"
                    title="Remove from split"
                >
                    <X size={wide ? 16 : 14} />
                </button>
            </div>
            <div className="flex-1 min-h-0">
                <HtmlDocView path={pane.path} line={pane.line} source={pane.source} onNavigate={onNavigate} onFrameFocus={onActivate} leaveGuard={leaveGuard} />
            </div>
        </div>
    )
}
