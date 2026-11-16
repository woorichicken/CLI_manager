import { useCallback, useEffect, useRef, useState } from 'react'
import { FilePreview } from './FilePreview'
import { setChatFileOpener } from '../utils/electronChatTransport'
import { BROWSER_PAGE_EXTENSIONS, SYSTEM_TYPES } from '../../../shared/fileKinds'

interface ChatFilePreviewProps {
    openInApp?: boolean
    /** Side by side on a web page: the page becomes a split pane next to the session (backlog 「앱 안 브라우저」 B). */
    onSideBySide?: (page: { path: string; line?: number; source: boolean }) => boolean
    /** why Side by side is off (the split is full) */
    sideBySideBlocked?: string | null
}

/**
 * Files the Chat view names (a path in an answer, a tool's file): pictures, text and web pages in the app's own preview
 * (the one ⌘P file search uses), anything else — a PDF, a video, a sound, an office file — in the Mac's own app, as ovis's
 * file viewer shows them. A web page is drawn in a sandboxed frame (decision 0013), its source and the browser one press
 * away; with a line it opens on the source. With Settings › Terminal › Chat view's switch off (0a17912b), everything goes
 * to the Mac's own app.
 */
export function ChatFilePreview({ openInApp = true, onSideBySide, sideBySideBlocked }: ChatFilePreviewProps) {
    const [target, setTarget] = useState<{ path: string; line?: number; sessionId?: string } | null>(null)
    /** Where the person was (the link in the Chat): focus goes back there when the preview closes. */
    const returnFocus = useRef<HTMLElement | null>(null)
    useEffect(() => {
        setChatFileOpener((path, line, sessionId) => {
            const extension = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? ''
            if (!openInApp || SYSTEM_TYPES.has(extension)) {
                void window.api.openChatPath(path, sessionId)
                return
            }
            returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            setTarget({ path, line, sessionId })
        })
        return () => setChatFileOpener(null)
    }, [openInApp])

    const close = useCallback(() => {
        setTarget(null)
        const back = returnFocus.current
        returnFocus.current = null
        // after the modal is gone, so nothing in it keeps the focus
        requestAnimationFrame(() => {
            if (back?.isConnected) back.focus({ preventScroll: true })
        })
    }, [])

    if (!target) return null
    const webPage = BROWSER_PAGE_EXTENSIONS.has(target.path.split('.').pop()?.toLowerCase() ?? '')
    return (
        <div data-testid="chat-file-preview" data-path={target.path}>
        <FilePreview
            isOpen
            filePath={target.path}
            line={target.line}
            renderMarkdown
            onClose={close}
            onOpenInEditor={() => {
                void window.api.openFileInEditor(target.path, '/', target.line)
                close()
            }}
            onOpenInBrowser={() => void window.api.openChatPath(target.path, target.sessionId)}
            onSideBySide={webPage && onSideBySide ? (source) => {
                if (onSideBySide({ path: target.path, line: target.line, source })) close()
            } : undefined}
            sideBySideBlocked={sideBySideBlocked}
        />
        </div>
    )
}
