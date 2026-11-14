import { useEffect, useState } from 'react'
import { FilePreview } from './FilePreview'
import { setChatFileOpener } from '../utils/electronChatTransport'
import { BROWSER_PAGE_EXTENSIONS, SYSTEM_TYPES } from '../../../shared/fileKinds'

/**
 * Files the Chat view names (a path in an answer, a tool's file): pictures and text in the
 * app's own preview (the one ⌘P file search uses), anything else — a PDF, a video, a sound,
 * an office file — in the Mac's own app, as ovis's file viewer shows them. A web page opens in the
 * browser (90043d9d); with a line it is a place in the source, so the preview shows that. With Settings ›
 * Terminal › Chat view's switch off (0a17912b), everything goes to the Mac's own app.
 */
export function ChatFilePreview({ openInApp = true }: { openInApp?: boolean }) {
    const [target, setTarget] = useState<{ path: string; line?: number } | null>(null)
    useEffect(() => {
        setChatFileOpener((path, line, sessionId) => {
            const extension = path.split('/').pop()?.split('.').pop()?.toLowerCase() ?? ''
            const page = BROWSER_PAGE_EXTENSIONS.has(extension) && line === undefined
            if (!openInApp || SYSTEM_TYPES.has(extension) || page) void window.api.openChatPath(path, sessionId)
            else setTarget({ path, line })
        })
        return () => setChatFileOpener(null)
    }, [openInApp])
    if (!target) return null
    return (
        <div data-testid="chat-file-preview" data-path={target.path}>
        <FilePreview
            isOpen
            filePath={target.path}
            line={target.line}
            renderMarkdown
            onClose={() => setTarget(null)}
            onOpenInEditor={() => {
                void window.api.openFileInEditor(target.path, '/', target.line)
                setTarget(null)
            }}
        />
        </div>
    )
}
