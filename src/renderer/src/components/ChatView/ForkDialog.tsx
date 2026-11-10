import { useEffect, useRef, useState } from 'react'
import { GitFork, Loader2, X } from 'lucide-react'
import type { ChatForkRequest, ChatForkResult, ChatForkScope, ConversationAgent } from '../../../../shared/conversation'

const AGENT_NAMES: Record<ConversationAgent, string> = { claude: 'Claude', codex: 'Codex' }
/** A finished fork's line stays this long (a failed one stays until dismissed). */
const DONE_SHOW_MS = 8000

/** The reply a fork starts from, as the view shows it. */
export interface ForkTarget {
    /** its place among all the conversation's turns */
    turnIndex: number
    turnTs: string | null
}

/**
 * «Fork into a new session» from one reply: what to carry over (the agent's own fork of the whole
 * conversation, or an excerpt up to this reply), the first message, and «Quote this reply». The new
 * session opens behind this one — the dialog closes at once and `ForkNotice` follows the request.
 */
export function ForkDialog({
    agent,
    wholeUnavailable,
    touch,
    onCancel,
    onFork
}: {
    agent: ConversationAgent
    /** why the whole conversation cannot be forked (no conversation file yet); null when it can */
    wholeUnavailable: string | null
    touch: boolean
    onCancel: () => void
    onFork: (request: Pick<ChatForkRequest, 'scope' | 'message' | 'quote'>) => void
}) {
    const [scope, setScope] = useState<ChatForkScope>(wholeUnavailable ? 'excerpt' : 'whole')
    const [message, setMessage] = useState('')
    const [quote, setQuote] = useState(false)
    const box = useRef<HTMLTextAreaElement>(null)
    // a touch screen opens its keyboard when the person taps the box, not before
    useEffect(() => {
        if (!touch) box.current?.focus()
    }, [touch])
    const name = AGENT_NAMES[agent]
    const submit = (): void => onFork({ scope, message, quote: scope === 'whole' && quote })
    return (
        <div className="chat-fork-layer" data-testid="chat-fork-dialog">
            <div className="chat-fork-backdrop" onClick={onCancel} />
            <div
                className="chat-fork-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="Fork into a new session"
                onKeyDown={(event) => {
                    if (event.key === 'Escape') {
                        event.preventDefault()
                        event.stopPropagation()
                        onCancel()
                    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault()
                        submit()
                    }
                }}
            >
                <div className="chat-fork-title">
                    <GitFork size={14} aria-hidden="true" /> Fork into a new session
                    <button type="button" className="chat-fork-close" aria-label="Cancel" onClick={onCancel}>
                        <X size={14} />
                    </button>
                </div>
                <fieldset className="chat-fork-scope">
                    <legend>What the new session gets</legend>
                    <label data-testid="chat-fork-scope-whole" data-disabled={wholeUnavailable ? 'true' : undefined}>
                        <input type="radio" name="chat-fork-scope" checked={scope === 'whole'} disabled={wholeUnavailable !== null} onChange={() => setScope('whole')} />
                        <span>
                            <strong>Whole conversation</strong>
                            <small>{wholeUnavailable ?? `${name}'s own fork of this conversation. The replies after this one come along too.`}</small>
                        </span>
                    </label>
                    <label data-testid="chat-fork-scope-excerpt">
                        <input type="radio" name="chat-fork-scope" checked={scope === 'excerpt'} onChange={() => setScope('excerpt')} />
                        <span>
                            <strong>Excerpt up to this reply</strong>
                            <small>A new {name} gets the last few turns up to this reply as its first message — copied, not summarized.</small>
                        </span>
                    </label>
                </fieldset>
                <label className="chat-fork-message">
                    <span>First message for the new session</span>
                    <textarea
                        ref={box}
                        data-testid="chat-fork-message"
                        rows={3}
                        value={message}
                        placeholder="What should the new session work on?"
                        onChange={(event) => setMessage(event.target.value)}
                    />
                </label>
                <label className="chat-fork-quote" data-testid="chat-fork-quote" data-disabled={scope === 'excerpt' ? 'true' : undefined}>
                    <input type="checkbox" checked={scope === 'whole' && quote} disabled={scope === 'excerpt'} onChange={(event) => setQuote(event.target.checked)} />
                    <span>Quote this reply{scope === 'excerpt' ? ' — the excerpt ends with it' : ''}</span>
                </label>
                <p className="chat-fork-note">
                    Same workspace, same {name} start command, named after this session with « · fork», under this one in Related. It opens behind — you stay here.
                </p>
                <div className="chat-fork-actions">
                    <button type="button" data-testid="chat-fork-cancel" onClick={onCancel}>
                        Cancel
                    </button>
                    <button type="button" className="chat-fork-primary" data-testid="chat-fork-submit" onClick={submit}>
                        Fork
                    </button>
                </div>
            </div>
        </div>
    )
}

export type ForkProgress =
    | { id: number; state: 'opening' }
    | { id: number; state: 'done'; result: ChatForkResult }

/** One line at the bottom while the new session opens and its first message goes, then what happened. */
export function ForkNotice({ progress, onShow, onDismiss }: { progress: ForkProgress; onShow?: (sessionId: string) => void; onDismiss: () => void }) {
    const result = progress.state === 'done' ? progress.result : null
    useEffect(() => {
        if (result?.status !== 'forked' || result.note) return
        const timer = window.setTimeout(onDismiss, DONE_SHOW_MS)
        return () => window.clearTimeout(timer)
    }, [result, onDismiss])
    const text = !result
        ? 'Opening the new session…'
        : result.status === 'rejected'
          ? `Not forked: ${result.message}`
          : `Forked into «${result.name}».${result.note ? ` ${result.note}` : result.messageSent ? ' The first message went in.' : ''}`
    return (
        <div className="chat-fork-notice" role="status" data-testid="chat-fork-notice" data-state={!result ? 'opening' : result.status}>
            {!result ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <GitFork size={14} aria-hidden="true" />}
            <span>{text}</span>
            {result?.status === 'forked' && onShow && (
                <button type="button" className="chat-fork-show" data-testid="chat-fork-show" onClick={() => (onShow(result.sessionId), onDismiss())}>
                    Show
                </button>
            )}
            {result && (
                <button type="button" aria-label="Dismiss" onClick={onDismiss}>
                    <X size={13} />
                </button>
            )}
        </div>
    )
}
