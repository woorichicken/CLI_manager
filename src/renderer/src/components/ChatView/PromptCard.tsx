import { useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronUp, ClipboardList, HelpCircle, ShieldQuestion, Terminal as TerminalIcon, X } from 'lucide-react'
import type { ChatTransport, PromptAnswer, PromptMenu, PromptOption } from '../../../../shared/conversation'

/**
 * The agent's question menu as a card at the bottom of the chat (ovis puts it
 * in the same place, above the composer). A button sends the keys the person
 * would press — main checks first that the screen still shows this very menu,
 * and refuses otherwise. Menus the app cannot answer safely (Codex's folder
 * trust, a layout never captured) show their text with "Answer in Terminal" only.
 *
 * A multiple choice is ticked here and sent with its Next/Submit button: main
 * presses Enter on each row whose tick differs, then on that row. The card's body
 * scrolls past a height and folds away (the ▴ button), so a long plan or many
 * options never cover the chat (fb 2c234a60).
 */
export function PromptCard({
    sessionId,
    prompt,
    transport,
    onOpenTerminal,
    onAnswered,
    picked = null,
    onConfirmPick,
    onCancelPick,
    readOnly = false
}: {
    sessionId: string
    prompt: PromptMenu
    transport: ChatTransport
    onOpenTerminal: () => void
    onAnswered: () => void
    /** an option number typed in the composer, waiting for Enter (ovis "type its number") */
    picked?: number | null
    onConfirmPick?: () => void
    onCancelPick?: () => void
    /** a view-only phone: the card is shown, its answers are not offered */
    readOnly?: boolean
}) {
    const [sending, setBusy] = useState(false)
    const busy = sending || readOnly
    const [error, setError] = useState<string | null>(null)
    const [customText, setCustomText] = useState('')
    const [collapsed, setCollapsed] = useState(false)
    const screenTicks = (): number[] => prompt.options.filter((option) => option.checked).map((option) => option.index)
    const [ticked, setTicked] = useState<number[]>(screenTicks)
    // another menu, or ticks changed in the terminal: start again from what the screen shows
    const ticksKey = `${prompt.signature}:${prompt.options.map((option) => (option.checked ? 1 : 0)).join('')}`
    useEffect(() => {
        setTicked(screenTicks())
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [ticksKey])
    const custom = prompt.options.find((option) => option.custom)
    const Icon = prompt.kind === 'plan' ? ClipboardList : prompt.kind === 'permission' || prompt.kind === 'trust' ? ShieldQuestion : HelpCircle
    const multi = prompt.multi && prompt.answerable && prompt.submitRow !== undefined

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
    const toggle = (option: PromptOption): void =>
        setTicked((now) => (now.includes(option.index) ? now.filter((index) => index !== option.index) : [...now, option.index].sort((a, b) => a - b)))
    const sendTicks = (): void => {
        if (ticked.length === 0 && !customText.trim()) return
        void answer({ signature: prompt.signature, optionIndices: ticked, ...(customText.trim() ? { customText } : {}) })
    }

    return (
        <div
            className="chat-prompt"
            data-testid="chat-prompt-card"
            data-kind={prompt.kind}
            data-answerable={prompt.answerable ? 'true' : 'false'}
            data-collapsed={collapsed ? 'true' : 'false'}
        >
            <div className="chat-prompt-head">
                <Icon size={14} className="text-amber-300 shrink-0" aria-hidden="true" />
                <span className="chat-prompt-question" data-testid="chat-prompt-question">
                    {prompt.question || 'The agent is waiting for an answer'}
                </span>
                <button
                    type="button"
                    className="chat-prompt-fold"
                    data-testid="chat-prompt-collapse"
                    aria-expanded={!collapsed}
                    title={collapsed ? 'Show the question' : 'Fold the question'}
                    onClick={() => setCollapsed((now) => !now)}
                >
                    {collapsed ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronUp size={14} aria-hidden="true" />}
                </button>
            </div>
            {prompt.steps && prompt.steps.length > 0 && (
                <div className="chat-prompt-steps" data-testid="chat-prompt-steps">
                    {prompt.steps.map((step, index) => (
                        <span
                            key={index}
                            className={`chat-prompt-step${step.answered ? ' is-answered' : ''}${step.submit ? ' is-submit' : ''}`}
                            data-testid="chat-prompt-step"
                            data-answered={step.answered ? 'true' : 'false'}
                        >
                            {step.answered && <Check size={10} aria-hidden="true" />}
                            {step.label}
                        </span>
                    ))}
                </div>
            )}
            {!collapsed && (
                <div className="chat-prompt-body" data-testid="chat-prompt-body">
                    {prompt.context.length > 0 && (
                        <div className={`chat-prompt-context${prompt.kind === 'plan' ? ' is-plan' : ''}`} data-testid="chat-prompt-context">
                            {prompt.context.map((line, index) => (
                                <div key={index}>{line}</div>
                            ))}
                        </div>
                    )}
                    <div className="chat-prompt-options">
                        {prompt.options
                            .filter((option) => !option.custom)
                            .map((option) => {
                                const box = multi && option.checked !== undefined
                                const on = ticked.includes(option.index)
                                return (
                                    <button
                                        key={option.index}
                                        type="button"
                                        className={`chat-prompt-option${option.selected ? ' is-selected' : ''}${picked !== null && option.number === picked ? ' is-picked' : ''}${box && on ? ' is-checked' : ''}`}
                                        data-testid="chat-prompt-option"
                                        data-index={option.index}
                                        {...(box ? { role: 'checkbox', 'aria-checked': on, 'data-checked': on ? 'true' : 'false' } : {})}
                                        disabled={busy || !prompt.answerable}
                                        onClick={() => (box ? toggle(option) : void answer({ signature: prompt.signature, optionIndex: option.index }))}
                                    >
                                        <span className="chat-prompt-number">
                                            {box ? <span className="chat-prompt-box">{on && <Check size={10} aria-hidden="true" />}</span> : option.number ?? '•'}
                                        </span>
                                        <span className="min-w-0">
                                            <span className="block">{option.label}</span>
                                            {option.description && <span className="chat-prompt-description">{option.description}</span>}
                                        </span>
                                    </button>
                                )
                            })}
                    </div>
                    {custom && prompt.answerable && (
                        <form
                            className="chat-prompt-custom"
                            onSubmit={(event) => {
                                event.preventDefault()
                                if (multi) sendTicks()
                                else if (customText.trim()) void answer({ signature: prompt.signature, customText })
                            }}
                        >
                            <input
                                value={customText}
                                onChange={(event) => setCustomText(event.target.value)}
                                placeholder={prompt.kind === 'plan' ? 'Tell Claude what to change…' : multi ? 'Add your own answer (optional)…' : 'Type your own answer…'}
                                data-testid="chat-prompt-custom-input"
                                disabled={busy}
                            />
                            {!multi && (
                                <button type="submit" disabled={busy || !customText.trim()} data-testid="chat-prompt-custom-send">
                                    {prompt.kind === 'plan' ? 'Send' : 'Answer'}
                                </button>
                            )}
                        </form>
                    )}
                    {multi && (
                        <button
                            type="button"
                            className="chat-prompt-multi-submit"
                            data-testid="chat-prompt-multi-submit"
                            disabled={busy || (ticked.length === 0 && !customText.trim())}
                            onClick={sendTicks}
                        >
                            {prompt.submitRow!.label} · {ticked.length + (customText.trim() ? 1 : 0)} picked
                        </button>
                    )}
                    {picked !== null && (
                        <div className="chat-prompt-picked" data-testid="chat-prompt-picked" role="status">
                            <span>
                                Option {picked} picked — <kbd>Enter</kbd> confirms · <kbd>Esc</kbd> cancels
                            </span>
                            <button type="button" data-testid="chat-prompt-confirm" disabled={busy} onClick={onConfirmPick}>
                                <Check size={12} aria-hidden="true" /> Confirm
                            </button>
                            <button type="button" onClick={onCancelPick} aria-label="Cancel">
                                <X size={12} aria-hidden="true" />
                            </button>
                        </div>
                    )}
                </div>
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
