import { useState } from 'react'
import { HelpCircle, ShieldQuestion, Terminal as TerminalIcon } from 'lucide-react'
import type { ChatTransport, PromptAnswer, PromptMenu } from '../../../../shared/conversation'

/**
 * The agent's question menu as a card at the bottom of the chat (ovis puts it
 * in the same place, above the composer). A button sends the keys the person
 * would press — main checks first that the screen still shows this very menu,
 * and refuses otherwise. Menus the app cannot answer safely (Codex,
 * multiple choice) show their text with "Answer in Terminal" only.
 */
export function PromptCard({
    sessionId,
    prompt,
    transport,
    onOpenTerminal,
    onAnswered
}: {
    sessionId: string
    prompt: PromptMenu
    transport: ChatTransport
    onOpenTerminal: () => void
    onAnswered: () => void
}) {
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [customText, setCustomText] = useState('')
    const custom = prompt.options.find((option) => option.custom)
    const Icon = prompt.kind === 'permission' || prompt.kind === 'trust' ? ShieldQuestion : HelpCircle

    const answer = async (value: PromptAnswer): Promise<void> => {
        setBusy(true)
        setError(null)
        try {
            const result = await transport.answerPrompt(sessionId, value)
            if (result.status === 'rejected') setError(result.message)
            else setCustomText('')
        } catch (failure) {
            setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
            setBusy(false)
            onAnswered()
        }
    }

    return (
        <div className="chat-prompt" data-testid="chat-prompt-card" data-kind={prompt.kind} data-answerable={prompt.answerable ? 'true' : 'false'}>
            <div className="chat-prompt-head">
                <Icon size={14} className="text-amber-300 shrink-0" aria-hidden="true" />
                <span className="chat-prompt-question" data-testid="chat-prompt-question">
                    {prompt.question || 'The agent is waiting for an answer'}
                </span>
            </div>
            {prompt.context.length > 0 && (
                <div className="chat-prompt-context">
                    {prompt.context.map((line, index) => (
                        <div key={index}>{line}</div>
                    ))}
                </div>
            )}
            <div className="chat-prompt-options">
                {prompt.options
                    .filter((option) => !option.custom)
                    .map((option) => (
                        <button
                            key={option.index}
                            type="button"
                            className={`chat-prompt-option${option.selected ? ' is-selected' : ''}`}
                            data-testid="chat-prompt-option"
                            data-index={option.index}
                            disabled={busy || !prompt.answerable}
                            onClick={() => void answer({ signature: prompt.signature, optionIndex: option.index })}
                        >
                            <span className="chat-prompt-number">{option.number ?? '•'}</span>
                            <span className="min-w-0">
                                <span className="block">{option.label}</span>
                                {option.description && <span className="chat-prompt-description">{option.description}</span>}
                            </span>
                        </button>
                    ))}
            </div>
            {custom && prompt.answerable && (
                <form
                    className="chat-prompt-custom"
                    onSubmit={(event) => {
                        event.preventDefault()
                        if (customText.trim()) void answer({ signature: prompt.signature, customText })
                    }}
                >
                    <input
                        value={customText}
                        onChange={(event) => setCustomText(event.target.value)}
                        placeholder="Type your own answer…"
                        data-testid="chat-prompt-custom-input"
                        disabled={busy}
                    />
                    <button type="submit" disabled={busy || !customText.trim()} data-testid="chat-prompt-custom-send">
                        Answer
                    </button>
                </form>
            )}
            {error && (
                <p className="chat-prompt-error" role="alert" data-testid="chat-prompt-error">
                    {error}
                </p>
            )}
            <div className="chat-prompt-foot">
                {!prompt.answerable && (
                    <span className="chat-prompt-why">
                        {prompt.multi ? 'Multiple choice — pick in the terminal.' : 'This menu is answered in the terminal.'}
                    </span>
                )}
                <button type="button" className="chat-link-button" data-testid="chat-prompt-terminal" onClick={onOpenTerminal}>
                    <TerminalIcon size={12} aria-hidden="true" /> Answer in Terminal
                </button>
            </div>
        </div>
    )
}
