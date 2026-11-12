import { useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, StickyNote, X } from 'lucide-react'
import { PHONE_API, type PhoneMemoResponse } from '../../../shared/phone'
import { shortenUrl, splitMemoLinks } from '../components/SessionMemo'
import { getJson } from './api'

/**
 * The session's memo pad on the phone, read-only (84188aa0): the Mac's pages, one at a time,
 * links as short taps. Read again each time it opens — the pad changes on the Mac.
 * Writing stays on the Mac for now: two places editing one pad needs a merge rule first.
 */
export function PhoneMemoPanel({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
    const [pages, setPages] = useState<string[] | null>(null)
    const [failed, setFailed] = useState(false)
    const [index, setIndex] = useState(0)

    useEffect(() => {
        let alive = true
        setPages(null)
        setFailed(false)
        setIndex(0)
        getJson<PhoneMemoResponse>(`${PHONE_API.memo}/${encodeURIComponent(sessionId)}`)
            .then((body) => {
                if (alive) setPages(body.pages.length > 0 ? body.pages : [''])
            })
            .catch(() => {
                if (alive) setFailed(true)
            })
        return () => {
            alive = false
        }
    }, [sessionId])

    const count = pages?.length ?? 0
    const page = pages?.[Math.min(index, count - 1)] ?? ''
    // the Mac's ‹ › go round; so do these
    const turn = (step: number): void => setIndex((current) => (current + step + count) % count)

    return (
        <section className="phone-memo" data-testid="phone-memo-panel" aria-label="Memo">
            <header className="phone-memo-head">
                <StickyNote size={15} aria-hidden="true" />
                <span className="phone-memo-title">Memo</span>
                {count > 1 && (
                    <>
                        <button type="button" className="phone-icon-button" aria-label="Previous page" data-testid="phone-memo-prev" onClick={() => turn(-1)}>
                            <ChevronLeft size={17} />
                        </button>
                        <span className="phone-memo-page" data-testid="phone-memo-page">
                            {index + 1} / {count}
                        </span>
                        <button type="button" className="phone-icon-button" aria-label="Next page" data-testid="phone-memo-next" onClick={() => turn(1)}>
                            <ChevronRight size={17} />
                        </button>
                    </>
                )}
                <button type="button" className="phone-icon-button" aria-label="Close memo" data-testid="phone-memo-close" onClick={onClose}>
                    <X size={17} />
                </button>
            </header>
            <div className="phone-memo-body" data-testid="phone-memo-text">
                {failed ? (
                    <p className="phone-memo-empty">Couldn't read the memo from the Mac.</p>
                ) : pages === null ? (
                    <p className="phone-memo-empty">Reading…</p>
                ) : page.trim() === '' ? (
                    <p className="phone-memo-empty">This page is empty.</p>
                ) : (
                    splitMemoLinks(page).map((segment, i) =>
                        segment.type === 'link' ? (
                            <a key={i} href={segment.url} target="_blank" rel="noopener noreferrer" title={segment.url} data-testid="phone-memo-link">
                                {shortenUrl(segment.url)}
                            </a>
                        ) : (
                            <span key={i}>{segment.text}</span>
                        )
                    )
                )}
            </div>
        </section>
    )
}
