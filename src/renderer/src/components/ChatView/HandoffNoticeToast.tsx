import { useEffect } from 'react'
import { Info, X } from 'lucide-react'
import { dismissHandoffNotice, useHandoffNotice } from './draftHandoff'

const SHOW_MS = 6000

/** The view switch's notice (draftHandoff.ts): one line at the bottom for a few seconds. Mac and phone. */
export function HandoffNoticeToast() {
    const notice = useHandoffNotice()
    useEffect(() => {
        if (!notice) return
        const timer = window.setTimeout(() => dismissHandoffNotice(notice.id), SHOW_MS)
        return () => window.clearTimeout(timer)
    }, [notice])
    if (!notice) return null
    return (
        <div className="draft-handoff-notice" role="status" data-testid="draft-handoff-notice" data-session-id={notice.sessionId}>
            <Info size={14} aria-hidden="true" />
            <span>{notice.text}</span>
            <button type="button" aria-label="Dismiss" onClick={() => dismissHandoffNotice(notice.id)}>
                <X size={13} />
            </button>
        </div>
    )
}
