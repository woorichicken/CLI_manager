import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, FileQuestion, RotateCw, ShieldAlert } from 'lucide-react'
import type { PhoneDocMessage, PhoneDocOpened, PhoneDocRefused, PhoneDocTarget } from '../../../shared/phone'
import { PHONE_API } from '../../../shared/phone'
import { postJson } from './api'
import { composeComment, keepDocStore } from './docMessages'
import { DocLinkSheet, DocSendSheet } from './DocSendSheet'
import { PhoneDocFrame } from './PhoneDocFrame'
import type { PhoneFileTarget } from './PhoneFilePanel'
import './phone-file.css'
import './phone-doc.css'

/**
 * An HTML report over the chat, as a page rather than its source (decision 0011). The chat stays mounted underneath, as
 * with any file. The Mac judges the path and hands back a token for the document's folder; the page's comments come here
 * as messages, and reach a session only through DocSendSheet.
 */

type Loaded = { state: 'loading' } | { state: 'offline' } | { state: 'refused'; refused: PhoneDocRefused } | { state: 'ok'; opened: PhoneDocOpened }
type Sheet = { kind: 'comment'; text: string } | { kind: 'link'; url: string }

const NOTICE_MS = 8000

export function PhoneDocPanel({ target, onClose, onOpenFile, onOpenChat }: { target: PhoneFileTarget; onClose: () => void; onOpenFile: (sessionId: string, path: string) => void; onOpenChat: (sessionId: string) => void }) {
    const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
    const [title, setTitle] = useState<string | null>(null)
    const [sheet, setSheet] = useState<Sheet | null>(null)
    const [missing, setMissing] = useState(0)
    const [notKept, setNotKept] = useState(false)
    const [notice, setNotice] = useState<{ text: string; target: PhoneDocTarget } | null>(null)
    /** the page now in the frame: a link inside the folder may have replaced the one opened */
    const rel = useRef<string | null>(null)
    const sheetOpen = useRef(false)
    sheetOpen.current = sheet !== null

    const load = useCallback(() => {
        setLoaded({ state: 'loading' })
        postJson<PhoneDocOpened | PhoneDocRefused>(PHONE_API.docOpen, { session: target.sessionId, path: target.path })
            .then((body) => setLoaded(body.status === 'ok' ? { state: 'ok', opened: body } : { state: 'refused', refused: body }))
            // the server's own gates (the phone switched off, pairing) answer in their own shape: not a verdict on this file
            .catch(() => setLoaded({ state: 'offline' }))
    }, [target.sessionId, target.path])
    useEffect(load, [load])

    useEffect(() => {
        if (!notice) return
        const timer = window.setTimeout(() => setNotice(null), NOTICE_MS)
        return () => window.clearTimeout(timer)
    }, [notice])

    const opened = loaded.state === 'ok' ? loaded.opened : null
    const onMessage = useCallback(
        (message: PhoneDocMessage): void => {
            if (!opened) return
            const current = rel.current ?? opened.rel
            switch (message.type) {
                case 'doc-ready':
                    rel.current = message.path.normalize('NFC')
                    if (message.title) setTitle(message.title)
                    setMissing(0)
                    return
                case 'doc-store':
                    // another page of the folder has no place of its own here: it must not overwrite this one's comments
                    if (current === opened.rel) setNotKept(!keepDocStore(opened.storeKey, message.value, window.localStorage))
                    return
                case 'doc-missing':
                    setMissing(message.count)
                    return
                case 'doc-comment':
                    // first come: words swapped while the person reads them are not taken
                    setSheet((open) => open ?? { kind: 'comment', text: composeComment(opened, current, message.text, window.location.origin) })
                    return
                case 'doc-link':
                    setSheet((open) => open ?? { kind: 'link', url: message.url })
                    return
                case 'doc-open':
                    if (!sheetOpen.current) onOpenFile(target.sessionId, message.path)
                    return
            }
        },
        [opened, onOpenFile, target.sessionId]
    )
    const closeSheet = useCallback(() => setSheet(null), [])

    const name = title ?? opened?.title ?? target.path.split('/').pop() ?? target.path
    return (
        <div
            className="phone-file-panel phone-doc-panel"
            data-testid="phone-doc-panel"
            // PhoneApp's drawer swipe starts from any touch at the left edge of the page: not from here
            onTouchStart={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
        >
            <header className="phone-header phone-file-header">
                <button type="button" className="phone-icon-button" aria-label="Back to the chat" data-testid="phone-doc-close" onClick={onClose}>
                    <ArrowLeft size={18} />
                </button>
                <span className="phone-header-title" data-testid="phone-doc-name">
                    {name}
                </span>
                {opened && (
                    <a className="phone-icon-button" href={`${opened.rawUrl}&download=1`} download={opened.rel} aria-label={`Download ${opened.rel}`} data-testid="phone-doc-save">
                        <Download size={18} />
                    </a>
                )}
            </header>
            {(missing > 0 || notKept) && (
                <p className="phone-doc-note" data-testid="phone-doc-missing" role="status">
                    {missing > 0 && `${missing} ${missing === 1 ? 'image or file' : 'images or files'} did not load: outside this folder or on the web.`}
                    {missing > 0 && notKept && ' '}
                    {notKept && 'These comments are too long to keep on this phone: send them before closing.'}
                </p>
            )}
            <div className="phone-doc-body" data-testid="phone-doc-body">
                {loaded.state === 'loading' && (
                    <p className="phone-file-center phone-file-note" data-testid="phone-doc-loading">
                        Reading from the Mac…
                    </p>
                )}
                {loaded.state === 'offline' && (
                    <div className="phone-file-center" data-testid="phone-doc-offline">
                        <p className="phone-file-big">The Mac is not answering</p>
                        <p className="phone-file-path">{target.path}</p>
                        <button type="button" className="phone-file-button" data-testid="phone-doc-retry" onClick={load}>
                            <RotateCw size={15} aria-hidden="true" /> Retry
                        </button>
                    </div>
                )}
                {loaded.state === 'refused' && (
                    <div className="phone-file-center" data-testid="phone-doc-refused" data-reason={loaded.refused.reason}>
                        {loaded.refused.reason === 'protected' ? <ShieldAlert size={24} aria-hidden="true" /> : <FileQuestion size={24} aria-hidden="true" />}
                        <p className="phone-file-big">{loaded.refused.message}</p>
                        <p className="phone-file-path">{target.path}</p>
                    </div>
                )}
                {opened && <PhoneDocFrame url={opened.url} storeKey={opened.storeKey} title={name} inert={sheet !== null} onMessage={onMessage} />}
                {opened && sheet?.kind === 'comment' && (
                    <DocSendSheet
                        text={sheet.text}
                        target={opened.target}
                        onCancel={closeSheet}
                        onOpenChat={onOpenChat}
                        onDone={(text, to) => {
                            setSheet(null)
                            setNotice({ text, target: to })
                        }}
                    />
                )}
                {sheet?.kind === 'link' && <DocLinkSheet url={sheet.url} onCancel={closeSheet} />}
                {notice && !sheet && (
                    <div className="phone-doc-notice" role="status" data-testid="phone-doc-notice">
                        <span>{notice.text}</span>
                        <button type="button" className="phone-doc-button" data-testid="phone-doc-notice-chat" onClick={() => onOpenChat(notice.target.id)}>
                            Open chat
                        </button>
                    </div>
                )}
            </div>
        </div>
    )
}
