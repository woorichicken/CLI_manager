import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Download, FileQuestion, RotateCw, ShieldAlert } from 'lucide-react'
import type { PhoneFileInfo, PhoneFileRefused } from '../../../shared/phone'
import { PHONE_API } from '../../../shared/phone'
import { HighlightedCode } from '../components/ChatView/markdown/HighlightedCode'
import { languageForFence } from '../components/ChatView/markdown/highlight'
import { Markdown } from '../components/ChatView/markdown/Markdown'
import './phone-file.css'

/**
 * A file the chat names, over the chat (decision 0010): the chat stays mounted underneath, so closing this leaves
 * its scroll and draft as they were. The Mac judges the path and answers with what to draw (phoneFiles.ts).
 */

export interface PhoneFileTarget {
    sessionId: string
    /** absolute, as the chat resolved it */
    path: string
    line?: number
}

type Loaded = { state: 'loading' } | { state: 'offline' } | { state: 'refused'; refused: PhoneFileRefused } | { state: 'ok'; info: PhoneFileInfo }

const MARKDOWN_NAME = /\.(?:md|mdx|markdown)$/i

const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const formatTime = (iso: string): string => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

async function fetchFile(target: PhoneFileTarget): Promise<Loaded> {
    const query = new URLSearchParams({ session: target.sessionId, path: target.path })
    try {
        const response = await fetch(`${PHONE_API.file}?${query}`, { credentials: 'same-origin' })
        const body = (await response.json()) as PhoneFileInfo | PhoneFileRefused | { error?: string }
        if ('status' in body && body.status === 'ok') return { state: 'ok', info: body }
        if ('status' in body && body.status === 'refused') return { state: 'refused', refused: body }
        // the server's own gates (the phone switched off, pairing) answer in their own shape: not a verdict on this file
        return { state: 'offline' }
    } catch {
        return { state: 'offline' }
    }
}

/** Code with its line numbers; `line` is marked and scrolled to. */
function CodeBody({ content, language, line }: { content: string; language: string | null; line?: number }) {
    const box = useRef<HTMLDivElement>(null)
    const grammar = useMemo(() => languageForFence(language ?? ''), [language])
    useEffect(() => {
        if (!line) return
        const row = box.current?.querySelectorAll('.hl-line')[line - 1]
        if (!row) return
        row.classList.add('is-target')
        row.scrollIntoView({ block: 'center' })
    }, [line, content])
    return (
        <div className="phone-file-code" ref={box} data-testid="phone-file-code">
            <HighlightedCode code={content} language={grammar} />
        </div>
    )
}

function TextBody({ info, line }: { info: Extract<PhoneFileInfo, { kind: 'text' | 'html' }>; line?: number }) {
    const markdown = info.kind === 'text' && MARKDOWN_NAME.test(info.name)
    // a line asked for is a place in the source: the rendered words have no line numbers
    const [source, setSource] = useState(!markdown || line !== undefined)
    return (
        <>
            {markdown && (
                <div className="phone-seg phone-file-switch" role="group" aria-label="Rendered or source">
                    <button type="button" aria-pressed={!source} data-testid="phone-file-rendered" onClick={() => setSource(false)}>
                        Rendered
                    </button>
                    <button type="button" aria-pressed={source} data-testid="phone-file-source" onClick={() => setSource(true)}>
                        Source
                    </button>
                </div>
            )}
            {info.maskedValues > 0 && (
                <p className="phone-file-note" data-testid="phone-file-masked">
                    {info.maskedValues === 1 ? '1 value hidden' : `${info.maskedValues} values hidden`}
                </p>
            )}
            {source ? (
                <CodeBody content={info.content} language={info.language} line={line} />
            ) : (
                <div className="phone-file-document">
                    <Markdown>{info.content}</Markdown>
                </div>
            )}
        </>
    )
}

function DownloadBody({ info }: { info: Extract<PhoneFileInfo, { kind: 'download' }> }) {
    const why = info.why === 'too_large_to_preview' ? 'Too large to show here.' : info.why === 'binary' ? 'Not a text file.' : null
    return (
        <div className="phone-file-center">
            <p className="phone-file-big" data-testid="phone-file-size">
                {formatSize(info.size)}
            </p>
            {why && <p className="phone-file-note">{why}</p>}
            <a className="phone-file-button" href={`${info.rawUrl}&download=1`} download={info.name} data-testid="phone-file-download">
                <Download size={15} aria-hidden="true" /> Download
            </a>
            <p className="phone-file-note">Saved by this phone’s browser</p>
        </div>
    )
}

export function PhoneFilePanel({ target, onClose }: { target: PhoneFileTarget; onClose: () => void }) {
    const [loaded, setLoaded] = useState<Loaded>({ state: 'loading' })
    const load = useCallback(() => {
        setLoaded({ state: 'loading' })
        void fetchFile(target).then(setLoaded)
    }, [target])
    useEffect(load, [load])

    const name = loaded.state === 'ok' ? loaded.info.name : (target.path.split('/').pop() ?? target.path)
    const info = loaded.state === 'ok' ? loaded.info : null
    return (
        <div
            className="phone-file-panel"
            data-testid="phone-file-panel"
            data-kind={info?.kind}
            // PhoneApp's drawer swipe starts from any touch at the left edge of the page: not from here
            onTouchStart={(event) => event.stopPropagation()}
            onTouchMove={(event) => event.stopPropagation()}
        >
            <header className="phone-header phone-file-header">
                <button type="button" className="phone-icon-button" aria-label="Back to the chat" data-testid="phone-file-close" onClick={onClose}>
                    <ArrowLeft size={18} />
                </button>
                <span className="phone-header-title" data-testid="phone-file-name">
                    {name}
                </span>
                {info && info.kind !== 'download' && (
                    <a className="phone-icon-button" href={`${info.rawUrl}&download=1`} download={info.name} aria-label={`Download ${info.name}`} data-testid="phone-file-save">
                        <Download size={18} />
                    </a>
                )}
            </header>
            <div className="phone-file-body" data-testid="phone-file-body">
                {loaded.state === 'loading' && (
                    <p className="phone-file-center phone-file-note" data-testid="phone-file-loading">
                        Reading from the Mac…
                    </p>
                )}
                {loaded.state === 'offline' && (
                    <div className="phone-file-center" data-testid="phone-file-offline">
                        <p className="phone-file-big">The Mac is not answering</p>
                        <p className="phone-file-path">{target.path}</p>
                        <button type="button" className="phone-file-button" data-testid="phone-file-retry" onClick={load}>
                            <RotateCw size={15} aria-hidden="true" /> Retry
                        </button>
                    </div>
                )}
                {loaded.state === 'refused' && (
                    <div className="phone-file-center" data-testid="phone-file-refused" data-reason={loaded.refused.reason}>
                        {loaded.refused.reason === 'protected' ? <ShieldAlert size={24} aria-hidden="true" /> : <FileQuestion size={24} aria-hidden="true" />}
                        <p className="phone-file-big">{loaded.refused.message}</p>
                        <p className="phone-file-path">{target.path}</p>
                    </div>
                )}
                {info?.kind === 'image' && (
                    <div className="phone-file-picture">
                        <img src={info.rawUrl} alt={info.name} data-testid="phone-file-image" />
                    </div>
                )}
                {/* HTML reads as code here; the document view takes this place (decision 0011) */}
                {(info?.kind === 'text' || info?.kind === 'html') && <TextBody info={info} line={target.line} />}
                {info?.kind === 'download' && <DownloadBody info={info} />}
            </div>
            {info && info.kind !== 'download' && (
                <footer className="phone-file-meta" data-testid="phone-file-meta">
                    {formatSize(info.size)} · {formatTime(info.modifiedAt)}
                </footer>
            )}
        </div>
    )
}
