import { QUICK_REPLY_COLORS, quickReplyColorOf, type QuickReplyColor } from '../../../shared/conversation'

/** The swatch for each colour — the 500 shade, which reads as that colour on either theme. */
const SWATCH: Record<QuickReplyColor, string> = {
    blue: '#3b82f6',
    green: '#22c55e',
    amber: '#f59e0b',
    red: '#ef4444',
    purple: '#a855f7',
    pink: '#ec4899',
    teal: '#14b8a6'
}

/** The reply's text in its colour, as the chat chip shows it on the dark chat (chat.css 300 tints) — the dialog is dark. */
const TEXT: Record<QuickReplyColor, string> = {
    blue: '#93c5fd',
    green: '#86efac',
    amber: '#fcd34d',
    red: '#fca5a5',
    purple: '#d8b4fe',
    pink: '#f9a8d4',
    teal: '#5eead4'
}

interface QuickReplyColorsProps {
    replies: string[]
    colors: Record<string, QuickReplyColor> | undefined
    onChange: (colors: Record<string, QuickReplyColor> | undefined) => void
}

/**
 * Settings › Terminal › Chat view: one row per quick reply with a few fixed colours to pick from, or none
 * (report 93bd4834). A fixed set keeps every chip readable on the chat; a free picker could not promise that.
 */
export function QuickReplyColors({ replies, colors, onChange }: QuickReplyColorsProps) {
    if (replies.length === 0) return null

    const pick = (reply: string, color: QuickReplyColor | null): void => {
        const next = { ...(colors ?? {}) }
        if (color) next[reply] = color
        else delete next[reply]
        onChange(Object.keys(next).length > 0 ? next : undefined)
    }

    /** None first, then the colours: the order ← / → walks. */
    const options: (QuickReplyColor | null)[] = [null, ...QUICK_REPLY_COLORS]

    // a radio group: ← / → (↑ / ↓) move the choice and the focus along the row, Tab stops on the chosen one
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>, reply: string, current: QuickReplyColor | null): void => {
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
        if (step === 0) return
        event.preventDefault()
        const next = options[(options.indexOf(current) + step + options.length) % options.length]
        pick(reply, next)
        const target = event.currentTarget.querySelector<HTMLButtonElement>(`[data-option="${next ?? 'none'}"]`)
        target?.focus()
    }

    const ring = 'outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1e1e20]'

    return (
        <div className="mt-3 space-y-1.5" data-testid="quick-reply-colors">
            <p className="text-xs text-gray-400">Colour</p>
            {replies.map((reply, index) => {
                const current = quickReplyColorOf(colors, reply) ?? null
                return (
                    // index in the key too: a row is a position in the list (the list is saved without repeats)
                    <div key={`${index}:${reply}`} className="flex items-center gap-3" data-testid={`quick-reply-color-${index}`}>
                        <span
                            className="flex-1 min-w-0 truncate text-xs"
                            style={current ? { color: TEXT[current] } : undefined}
                            title={reply}
                        >
                            {reply}
                        </span>
                        <div
                            className="flex items-center gap-1 shrink-0"
                            role="radiogroup"
                            aria-label={`Colour for “${reply}”`}
                            onKeyDown={(event) => onKeyDown(event, reply, current)}
                        >
                            {options.map((option) => {
                                const checked = option === current
                                const name = option ? option[0].toUpperCase() + option.slice(1) : 'No colour'
                                return (
                                    <button
                                        key={option ?? 'none'}
                                        type="button"
                                        role="radio"
                                        aria-checked={checked}
                                        aria-label={name}
                                        title={name}
                                        tabIndex={checked ? 0 : -1}
                                        data-option={option ?? 'none'}
                                        data-testid={`quick-reply-color-${index}-${option ?? 'none'}`}
                                        onClick={() => pick(reply, option)}
                                        className={
                                            option
                                                ? `w-5 h-5 rounded-full border ${ring} ${checked ? 'border-white ring-1 ring-white/60' : 'border-transparent hover:border-white/50'}`
                                                : `w-5 h-5 rounded-full border flex items-center justify-center text-[10px] text-gray-400 ${ring} ${checked ? 'border-white ring-1 ring-white/60' : 'border-white/20 hover:border-white/50'}`
                                        }
                                        style={option ? { backgroundColor: SWATCH[option] } : undefined}
                                    >
                                        {option ? null : '∅'}
                                    </button>
                                )
                            })}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
