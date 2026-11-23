import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react'
import { QUICK_REPLY_COLORS, keepQuickReplyColors, quickReplyColorOf, type QuickReplyColor } from '../../../shared/conversation'
// the colour dot is the chat's own chip (.chat-quick-reply), so it shows exactly what the chat will
import './ChatView/chat.css'

/** The chat shows this many chips at most — the list was cut here before (one per line), so it still is. */
export const MAX_QUICK_REPLIES = 8

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

/**
 * The chip's dark-chat text and fill (chat.css 300 tints, 14% fill). Settings stays dark even under the
 * `light` class (its light rules do not reach the dialog — docs/found-defects.md, Theme), so the dot pins
 * these rather than taking chat.css's light-theme ones, which would be dark green on the dark dialog.
 */
const DARK_CHIP: Record<QuickReplyColor, { fg: string; fill: string }> = {
    blue: { fg: '#93c5fd', fill: 'rgba(59, 130, 246, 0.14)' },
    green: { fg: '#86efac', fill: 'rgba(34, 197, 94, 0.14)' },
    amber: { fg: '#fcd34d', fill: 'rgba(245, 158, 11, 0.14)' },
    red: { fg: '#fca5a5', fill: 'rgba(239, 68, 68, 0.14)' },
    purple: { fg: '#d8b4fe', fill: 'rgba(168, 85, 247, 0.14)' },
    pink: { fg: '#f9a8d4', fill: 'rgba(236, 72, 153, 0.14)' },
    teal: { fg: '#5eead4', fill: 'rgba(20, 184, 166, 0.14)' }
}

/** None first, then the colours: the order ← / → walks. */
const OPTIONS: (QuickReplyColor | null)[] = [null, ...QUICK_REPLY_COLORS]

const colorName = (color: QuickReplyColor | null): string => (color ? color[0].toUpperCase() + color.slice(1) : 'No colour')

/** A row on screen. The colour belongs to the row, so renaming a reply keeps its colour. */
interface Row {
    id: number
    text: string
    color: QuickReplyColor | null
}

/** What is saved: the rows' texts, without blanks or repeats, and the colours of those texts (first row wins). */
function toSaved(rows: Row[]): { quickReplies: string[]; quickReplyColors: Record<string, QuickReplyColor> | undefined } {
    const quickReplies = rows
        .map((row) => row.text.trim())
        .filter(Boolean)
        .filter((text, index, all) => all.indexOf(text) === index)
        .slice(0, MAX_QUICK_REPLIES)
    const byText: Record<string, QuickReplyColor> = {}
    const seen = new Set<string>()
    for (const row of rows) {
        const text = row.text.trim()
        // a repeat later in the list does not take over the first row's colour (or lack of one)
        if (!text || seen.has(text)) continue
        seen.add(text)
        if (row.color) byText[text] = row.color
    }
    // the same rule as before: only colours of texts still on the list
    return { quickReplies, quickReplyColors: keepQuickReplyColors(byText, quickReplies) }
}

const savedKey = (saved: { quickReplies: string[]; quickReplyColors: Record<string, QuickReplyColor> | undefined }): string =>
    JSON.stringify([saved.quickReplies, saved.quickReplyColors ?? {}])

interface QuickReplyEditorProps {
    replies: string[]
    colors: Record<string, QuickReplyColor> | undefined
    onChange: (quickReplies: string[], quickReplyColors: Record<string, QuickReplyColor> | undefined) => void
}

/**
 * Settings › Chat › Quick replies as one list (report c44bf0af): per row the colour dot (the chat's
 * chip in its colour; a small radio group pops from it), the reply's text, move up / down and delete,
 * then «+ Add reply». It replaces a text box with a second «Colour» list under it that repeated every reply.
 * Saved as before — `quickReplies` strings and `quickReplyColors` by text — so the chat and phones read it unchanged.
 */
export function QuickReplyEditor({ replies, colors, onChange }: QuickReplyEditorProps) {
    const nextId = useRef(0)
    const fromSaved = (list: string[], map: Record<string, QuickReplyColor> | undefined): Row[] =>
        list.map((text) => ({ id: nextId.current++, text, color: quickReplyColorOf(map, text) ?? null }))

    const [rows, setRows] = useState<Row[]>(() => fromSaved(replies, colors))
    const [openId, setOpenId] = useState<number | null>(null)
    const [focusId, setFocusId] = useState<string | null>(null)
    const listRef = useRef<HTMLDivElement>(null)
    // what this editor last saved: the rows keep their blank and repeated lines while they match it
    const lastSaved = useRef(savedKey({ quickReplies: replies, quickReplyColors: colors }))

    // a change from elsewhere (not this editor) starts the rows over
    useEffect(() => {
        const key = savedKey({ quickReplies: replies, quickReplyColors: colors })
        if (key === lastSaved.current) return
        lastSaved.current = key
        setRows(fromSaved(replies, colors))
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [replies, colors])

    // a new row's text box, or the next thing after a delete, takes the focus once it is drawn
    useEffect(() => {
        if (focusId === null) return
        listRef.current?.querySelector<HTMLElement>(`[data-focus-id="${focusId}"]`)?.focus()
        setFocusId(null)
    }, [focusId, rows])

    const commit = (next: Row[]): void => {
        setRows(next)
        const saved = toSaved(next)
        const key = savedKey(saved)
        if (key === lastSaved.current) return
        lastSaved.current = key
        onChange(saved.quickReplies, saved.quickReplyColors)
    }

    const edit = (id: number, patch: Partial<Row>): void => commit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)))
    const move = (index: number, step: -1 | 1): void => {
        const next = [...rows]
        ;[next[index], next[index + step]] = [next[index + step], next[index]]
        commit(next)
    }
    const remove = (index: number): void => {
        const next = rows.filter((_, i) => i !== index)
        commit(next)
        // the focus stays in the list: the row that took its place, else the one above, else «Add»
        const after = next[index] ?? next[index - 1]
        setFocusId(after ? `${after.id}-delete` : 'add')
    }
    const add = (): void => {
        const row = { id: nextId.current++, text: '', color: null }
        commit([...rows, row])
        setFocusId(String(row.id))
    }

    const ring = 'outline-none focus-visible:ring-2 focus-visible:ring-blue-400 focus-visible:ring-offset-2 focus-visible:ring-offset-[#1e1e20]'
    const iconButton = `w-6 h-6 flex items-center justify-center rounded text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-gray-400 ${ring}`
    const full = rows.length >= MAX_QUICK_REPLIES
    const seen = new Set<string>()

    return (
        <div ref={listRef} data-testid="quick-reply-editor" className="space-y-1.5">
            {rows.map((row, index) => {
                const text = row.text.trim()
                const repeat = text !== '' && seen.has(text)
                if (text) seen.add(text)
                return (
                    <div
                        key={row.id}
                        data-testid={`quick-reply-row-${index}`}
                        data-duplicate={repeat ? 'true' : undefined}
                        className="relative flex items-center gap-2"
                    >
                        <ColorDot
                            index={index}
                            reply={text}
                            color={row.color}
                            open={openId === row.id}
                            onOpen={(open) => setOpenId(open ? row.id : null)}
                            onPick={(color) => edit(row.id, { color })}
                            ring={ring}
                        />
                        <input
                            type="text"
                            value={row.text}
                            placeholder="Reply"
                            aria-label={`Reply ${index + 1}`}
                            data-testid={`quick-reply-text-${index}`}
                            data-focus-id={row.id}
                            title={repeat ? 'Same as a reply above: saved once' : undefined}
                            onChange={(event) => edit(row.id, { text: event.target.value })}
                            className={`flex-1 min-w-0 bg-black/30 border border-white/10 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-blue-500 ${repeat ? 'text-gray-500' : 'text-white'}`}
                        />
                        {repeat && <span className="text-[11px] text-gray-500 shrink-0">Repeat</span>}
                        <div className="flex items-center shrink-0">
                            <button type="button" aria-label="Move up" title="Move up" data-testid={`quick-reply-up-${index}`} disabled={index === 0} onClick={() => move(index, -1)} className={iconButton}>
                                <ChevronUp size={14} />
                            </button>
                            <button type="button" aria-label="Move down" title="Move down" data-testid={`quick-reply-down-${index}`} disabled={index === rows.length - 1} onClick={() => move(index, 1)} className={iconButton}>
                                <ChevronDown size={14} />
                            </button>
                            <button type="button" aria-label="Delete reply" title="Delete reply" data-testid={`quick-reply-delete-${index}`} data-focus-id={`${row.id}-delete`} onClick={() => remove(index)} className={iconButton}>
                                <X size={14} />
                            </button>
                        </div>
                    </div>
                )
            })}
            <div className="flex items-center justify-between gap-3 pt-1">
                <button
                    type="button"
                    data-testid="quick-reply-add"
                    data-focus-id="add"
                    disabled={full}
                    title={full ? `Up to ${MAX_QUICK_REPLIES} replies` : undefined}
                    onClick={add}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-xs text-blue-300 hover:bg-white/10 disabled:text-gray-500 disabled:hover:bg-transparent ${ring}`}
                >
                    <Plus size={12} /> Add reply
                </button>
                <p className="text-[11px] text-gray-500">Up to {MAX_QUICK_REPLIES}. Empty rows and repeats are not saved.</p>
            </div>
        </div>
    )
}

interface ColorDotProps {
    index: number
    reply: string
    color: QuickReplyColor | null
    open: boolean
    onOpen: (open: boolean) => void
    onPick: (color: QuickReplyColor | null) => void
    ring: string
}

/** The row's chip in its colour; pressing it pops a small radio group of the fixed colours (report 93bd4834). */
function ColorDot({ index, reply, color, open, onOpen, onPick, ring }: ColorDotProps) {
    const triggerRef = useRef<HTMLButtonElement>(null)
    const popoverRef = useRef<HTMLDivElement>(null)

    // opening puts the focus on the chosen colour, as Tab into a radio group would
    useEffect(() => {
        if (!open) return
        popoverRef.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()
    }, [open])

    // a press anywhere else closes it
    useEffect(() => {
        if (!open) return
        const onDown = (event: MouseEvent): void => {
            const target = event.target as Node
            if (popoverRef.current?.contains(target) || triggerRef.current?.contains(target)) return
            onOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        return () => document.removeEventListener('mousedown', onDown)
    }, [open, onOpen])

    const close = (): void => {
        onOpen(false)
        triggerRef.current?.focus()
    }

    // a radio group: ← / → (↑ / ↓) move the choice and the focus along the row; Esc closes and goes back to the dot
    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === 'Escape') {
            event.preventDefault()
            // only the popover closes, not the dialog around it
            event.stopPropagation()
            close()
            return
        }
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
        if (step === 0) return
        event.preventDefault()
        const next = OPTIONS[(OPTIONS.indexOf(color) + step + OPTIONS.length) % OPTIONS.length]
        onPick(next)
        popoverRef.current?.querySelector<HTMLButtonElement>(`[data-option="${next ?? 'none'}"]`)?.focus()
    }

    const label = reply || `reply ${index + 1}`
    return (
        <div className="relative shrink-0">
            <button
                ref={triggerRef}
                type="button"
                data-testid={`quick-reply-color-${index}`}
                data-color={color ?? undefined}
                aria-haspopup="dialog"
                aria-expanded={open}
                aria-label={`Colour for “${label}”: ${colorName(color)}`}
                title={`Colour: ${colorName(color)}`}
                onClick={() => onOpen(!open)}
                className={`chat-quick-reply ${ring}`}
                // the plain chip reads the chat's line and text tints, which live on the chat view; a coloured one its dark tints
                style={{
                    padding: '2px 9px',
                    fontSize: 12,
                    lineHeight: '18px',
                    ['--chat-line' as string]: 'rgba(255, 255, 255, 0.18)',
                    ['--chat-dim' as string]: '#a0a0a0',
                    ...(color ? { ['--qr-fg' as string]: DARK_CHIP[color].fg, ['--qr-fill' as string]: DARK_CHIP[color].fill } : {})
                }}
            >
                Aa
            </button>
            {open && (
                // the dialog's own surface and border classes, so it looks like the dialog whichever way that is drawn
                <div
                    ref={popoverRef}
                    data-testid="quick-reply-color-popover"
                    role="dialog"
                    aria-label={`Colour for “${label}”`}
                    onKeyDown={onKeyDown}
                    onBlur={(event) => {
                        // Tab out of the group closes it
                        if (!popoverRef.current?.contains(event.relatedTarget as Node | null) && event.relatedTarget !== triggerRef.current) onOpen(false)
                    }}
                    className="absolute left-0 top-full mt-1 z-20 p-2 rounded-lg border border-white/10 bg-[#1e1e20] shadow-xl"
                >
                    <div className="flex items-center gap-1.5" role="radiogroup" aria-label={`Colour for “${label}”`}>
                        {OPTIONS.map((option) => {
                            const checked = option === color
                            const name = colorName(option)
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
                                    onClick={() => {
                                        onPick(option)
                                        close()
                                    }}
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
            )}
        </div>
    )
}
