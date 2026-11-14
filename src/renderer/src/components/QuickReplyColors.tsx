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

    return (
        <div className="mt-3 space-y-1.5" data-testid="quick-reply-colors">
            <p className="text-xs text-gray-400">Colour</p>
            {replies.map((reply, index) => {
                const current = quickReplyColorOf(colors, reply) ?? null
                return (
                    <div key={reply} className="flex items-center gap-3" data-testid={`quick-reply-color-${index}`}>
                        <span
                            className="flex-1 min-w-0 truncate text-xs"
                            style={current ? { color: SWATCH[current] } : undefined}
                            title={reply}
                        >
                            {reply}
                        </span>
                        <div className="flex items-center gap-1 shrink-0" role="radiogroup" aria-label={`Colour for “${reply}”`}>
                            <button
                                type="button"
                                role="radio"
                                aria-checked={current === null}
                                aria-pressed={current === null}
                                aria-label="No colour"
                                title="No colour"
                                data-testid={`quick-reply-color-${index}-none`}
                                onClick={() => pick(reply, null)}
                                className={`w-5 h-5 rounded-full border flex items-center justify-center text-[10px] text-gray-400 ${current === null ? 'border-white ring-1 ring-white/60' : 'border-white/20 hover:border-white/50'}`}
                            >
                                ∅
                            </button>
                            {QUICK_REPLY_COLORS.map((color) => (
                                <button
                                    key={color}
                                    type="button"
                                    role="radio"
                                    aria-checked={current === color}
                                    aria-pressed={current === color}
                                    aria-label={color}
                                    title={color[0].toUpperCase() + color.slice(1)}
                                    data-testid={`quick-reply-color-${index}-${color}`}
                                    onClick={() => pick(reply, color)}
                                    className={`w-5 h-5 rounded-full border ${current === color ? 'border-white ring-1 ring-white/60' : 'border-transparent hover:border-white/50'}`}
                                    style={{ backgroundColor: SWATCH[color] }}
                                />
                            ))}
                        </div>
                    </div>
                )
            })}
        </div>
    )
}
