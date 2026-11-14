import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, ArrowUp, FileText, Loader2, Plus, Square, X } from 'lucide-react'
import type { ChatCommand, ChatPreferences, ChatSendOptions, ChatSendResult, ChatTransport } from '../../../../shared/conversation'
import { InputBusyNote } from './InputBusyNote'
import { DEFAULT_QUICK_REPLIES, MAX_CHAT_TEXT_LENGTH } from '../../../../shared/conversation'
import { activeTrigger, commandPieces, fileMention, mayNameCommand, rankCommands } from './chatLib'
import { appendDraft, onDraftReplaced, readDraft, saveDraft } from './draftStore'
import { DictationButton } from './DictationButton'
import { useDictation } from './useDictation'

export { appendDraft } from './draftStore'

/** How often each `/` command was picked, so the menu offers the usual ones first (ovis `ovis:slash-usage`). */
const USAGE_KEY = 'chat-command-usage'
function readUsage(): Record<string, number> {
    try {
        const parsed = JSON.parse(localStorage.getItem(USAGE_KEY) ?? '{}') as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {}
    } catch {
        return {}
    }
}
function bumpUsage(name: string): void {
    const usage = readUsage()
    usage[name] = (usage[name] ?? 0) + 1
    try {
        localStorage.setItem(USAGE_KEY, JSON.stringify(usage))
    } catch {
        // not kept: the order just does not learn
    }
}

/** After the terminal's own focus-on-show (TerminalView) has run. */
const FOCUS_DELAY_MS = 150
/** Taller than this, the box scrolls instead of growing. */
const MAX_ROWS = 10
/** Wait this long after a keystroke before asking for files. */
const FILE_SEARCH_DELAY_MS = 120
/** A picture bigger than this gets no thumbnail on its tile. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024
/** The "characters left" hint shows past this share of the limit. */
const NEAR_LIMIT = 0.9

interface Attachment {
    id: number
    name: string
    size: number
    previewUrl: string | null
    state: 'attaching' | 'ready' | 'error'
    path?: string
    error?: string
}
let attachmentSequence = 0

const SOURCE_LABEL: Record<ChatCommand['source'], string> = {
    builtin: 'built-in',
    skill: 'skill',
    command: 'command',
    project: 'project',
    prompt: 'prompt'
}

export interface ComposerHandle {
    focus(): void
    addFiles(files: File[]): void
    /**
     * puts text in the box (a queued message taken back to edit): into an empty box, or after the
     * draft. `forSession`: the session it was taken from — when the box shows another one now, the
     * text goes to that session's saved draft instead (round2 N01).
     */
    editText(text: string, forSession?: string): void
    /** the mic: starts listening into the box, or stops (⌘⇧D) — nothing where dictation is unavailable */
    toggleDictation(): void
}

export interface ComposerProps {
    sessionId: string
    transport: ChatTransport
    agentName: string
    codex: boolean
    working: boolean
    /** a question card is on screen: its option numbers can be typed here */
    promptOptions: number[] | null
    /** a number was typed for the card and waits for Enter (confirm) or Esc */
    pendingPick: boolean
    onPick(number: number): void
    onConfirmPick(): void
    onCancelPick(): void
    preferences: ChatPreferences
    /** a touch screen: Return is a new line (Send sends) and opening the chat leaves the keyboard down */
    touch?: boolean
    /** Embedded thread views leave initial focus to their enclosing panel. */
    autoFocus?: boolean
    placeholder?: string
    onSend(text: string, options?: ChatSendOptions): Promise<ChatSendResult>
    onInterrupt(): Promise<string | null>
    /** the row under the box (model, context, plan) */
    status?: ReactNode
}

/**
 * Several lines, Enter sends, Shift+Enter breaks the line (or ⌘/Ctrl+Enter sends, by Settings).
 * Sending types into the session's own terminal through main (the Control API's typing path).
 * Main refuses while a question is on screen or the terminal's input line already holds text,
 * and queues it while the agent works — the note above the box says which happened.
 *
 * Also: `/` command and `@` file completion, files attached by ＋ / paste / drop (sent as `@path`),
 * Stop (and Esc) while the agent works, one-tap replies, the length limit, and the card's numbers.
 */
export const Composer = forwardRef<ComposerHandle, ComposerProps>(function Composer(
    { sessionId, transport, agentName, codex, working, promptOptions, pendingPick, onPick, onConfirmPick, onCancelPick, preferences, touch = false, autoFocus = true, placeholder: messagePlaceholder, onSend, onInterrupt, status },
    ref
) {
    const [text, setText] = useState(() => readDraft(sessionId))
    const [caret, setCaret] = useState(0)
    /** messages on their way into the terminal */
    const [sending, setSending] = useState(0)
    /**
     * the quick reply on its way (b17fa869). A busy Mac or a slow link takes seconds to answer, and
     * the chip stays under the thumb: a second tap sent the same reply twice. The ref stops a tap in
     * the same frame, the state shows which chip is going.
     */
    const [quickInFlight, setQuickInFlight] = useState<string | null>(null)
    const quickInFlightRef = useRef<string | null>(null)
    const [notice, setNotice] = useState<{ tone: 'info' | 'error'; text: string } | null>(null)
    /** a send refused for text left in the terminal's input box, which main can clear (C-1) */
    const [busyDraft, setBusyDraft] = useState<string | null>(null)
    const [attachments, setAttachments] = useState<Attachment[]>([])
    const [commands, setCommands] = useState<ChatCommand[] | null>(null)
    const [files, setFiles] = useState<string[]>([])
    const [menuIndex, setMenuIndex] = useState(0)
    const [menuDismissed, setMenuDismissed] = useState(false)
    const [dragging, setDragging] = useState(false)
    const box = useRef<HTMLTextAreaElement>(null)
    const backdrop = useRef<HTMLDivElement>(null)
    const picker = useRef<HTMLInputElement>(null)
    const attachmentsRef = useRef<Attachment[]>([])
    attachmentsRef.current = attachments
    const textRef = useRef(text)
    textRef.current = text

    useEffect(() => {
        setText(readDraft(sessionId))
        setNotice(null)
        setBusyDraft(null)
        setCommands(null)
        setAttachments([])
        // The terminal under the chat may still hold focus: keys would go to it unseen.
        // Take focus only from it (or from nothing), never from another input.
        // A touch screen: focus raises the soft keyboard over the chat the user came to read — leave it.
        if (touch || !autoFocus) return
        const timer = window.setTimeout(() => {
            const active = document.activeElement
            const terminal = active?.closest?.(`[data-session-id="${CSS.escape(sessionId)}"]`)
            if (!active || active === document.body || (terminal && active.closest('.xterm'))) box.current?.focus()
        }, FOCUS_DELAY_MS)
        return () => window.clearTimeout(timer)
    }, [sessionId])

    // The view switch moved text in or out while this box was there (4b9cb0c2).
    useEffect(() => onDraftReplaced(sessionId, (next) => setText(next)), [sessionId])

    useEffect(() => {
        const element = box.current
        if (!element) return
        element.style.height = 'auto'
        const line = parseFloat(getComputedStyle(element).lineHeight) || 18
        const max = line * MAX_ROWS + 16
        element.style.height = `${Math.min(element.scrollHeight, max)}px`
        // a scroll bar only once it stops growing (a fraction of a pixel would show one on every line)
        element.style.overflowY = element.scrollHeight > max ? 'auto' : 'hidden'
    }, [text])

    const setDraft = useCallback(
        (next: string, nextCaret?: number) => {
            setText(next)
            saveDraft(sessionId, next)
            setMenuDismissed(false)
            if (nextCaret !== undefined) {
                setCaret(nextCaret)
                window.requestAnimationFrame(() => {
                    box.current?.focus()
                    box.current?.setSelectionRange(nextCaret, nextCaret)
                })
            }
        },
        [sessionId]
    )

    // ---- dictation (the mic, macOS) ------------------------------------------------------------
    const readBox = useCallback(() => {
        const element = box.current
        const length = textRef.current.length
        return { text: textRef.current, start: element?.selectionStart ?? length, end: element?.selectionEnd ?? length }
    }, [])
    const dictation = useDictation({
        dictation: transport.dictation,
        sessionId,
        agent: codex ? 'codex' : 'claude',
        readBox,
        write: setDraft,
        onError: (message) => setNotice({ tone: 'error', text: message })
    })
    // dictated words wiped out of the box without sending — the dictation log's `edited-away`
    const boxEmptied = dictation.boxEmptied
    useEffect(() => {
        if (text.trim() === '') boxEmptied()
    }, [text, boxEmptied])

    // ---- attachments -----------------------------------------------------------------------
    const addFiles = useCallback(
        (picked: File[]) => {
            if (picked.length === 0) return
            const added = picked.map<{ item: Attachment; file: File }>((file) => ({
                file,
                item: {
                    id: ++attachmentSequence,
                    name: file.name || 'pasted image',
                    size: file.size,
                    previewUrl: null,
                    state: 'attaching'
                }
            }))
            setAttachments((current) => [...current, ...added.map(({ item }) => item)])
            for (const { item, file } of added) {
                // a thumbnail as a data: URL — the app's page allows no blob: pictures (CSP img-src 'self' data:)
                if (file.type.startsWith('image/') && file.size <= MAX_PREVIEW_BYTES) {
                    const reader = new FileReader()
                    reader.onload = () => {
                        const url = typeof reader.result === 'string' ? reader.result : null
                        if (url) setAttachments((current) => current.map((entry) => (entry.id === item.id ? { ...entry, previewUrl: url } : entry)))
                    }
                    reader.readAsDataURL(file)
                }
                void transport
                    .attachFile(sessionId, file)
                    .catch((error: unknown) => ({ status: 'rejected' as const, reason: 'unreadable' as const, message: error instanceof Error ? error.message : String(error) }))
                    .then((result) => {
                        setAttachments((current) =>
                            current.map((entry) =>
                                entry.id !== item.id
                                    ? entry
                                    : result.status === 'attached'
                                      ? { ...entry, state: 'ready', path: result.path }
                                      : { ...entry, state: 'error', error: result.message }
                            )
                        )
                    })
            }
            box.current?.focus()
        },
        [sessionId, transport]
    )

    const removeAttachment = (id: number): void => {
        setAttachments((current) =>
            current.filter((item) => {
                return item.id !== id
            })
        )
    }

    useImperativeHandle(
        ref,
        () => ({
            focus: () => box.current?.focus(),
            addFiles,
            editText: (incoming: string, forSession?: string) => {
                if (forSession !== undefined && forSession !== sessionId) {
                    appendDraft(forSession, incoming)
                    return
                }
                const next = text.trim() ? `${text}\n${incoming}` : incoming
                setDraft(next, next.length)
            },
            toggleDictation: () => {
                if (!dictation.available) return
                box.current?.focus()
                dictation.toggle()
            }
        }),
        [addFiles, setDraft, text, sessionId, dictation]
    )

    // ---- completion menu -------------------------------------------------------------------
    const trigger = menuDismissed ? null : activeTrigger(text, caret, codex)
    // the menu needs the list, and so does telling which words in the draft are commands
    const wantsCommands = trigger?.kind === 'slash' || mayNameCommand(text)
    useEffect(() => {
        if (!wantsCommands || commands !== null) return
        let live = true
        void transport
            .listCommands(sessionId)
            .then((list) => live && setCommands(list))
            .catch(() => live && setCommands([]))
        return () => {
            live = false
        }
    }, [wantsCommands, commands, sessionId, transport])

    const fileQuery = trigger?.kind === 'file' ? trigger.query : null
    useEffect(() => {
        if (fileQuery === null) return
        let live = true
        const timer = window.setTimeout(() => {
            void transport
                .searchFiles(sessionId, fileQuery)
                .then((found) => live && setFiles(found))
                .catch(() => live && setFiles([]))
        }, FILE_SEARCH_DELAY_MS)
        return () => {
            live = false
            window.clearTimeout(timer)
        }
    }, [fileQuery, sessionId, transport])

    const usage = useMemo(readUsage, [trigger?.kind])
    const commandChoices = trigger?.kind === 'slash' && commands ? rankCommands(commands, trigger, usage) : []
    const choices: (ChatCommand | string)[] = trigger?.kind === 'slash' ? commandChoices : trigger?.kind === 'file' ? files : []
    // Only the command reads light blue, wherever it stands (85259f8e · 1fcd9008 · e833d0b9). A textarea has one
    // colour, so its words go transparent and a copy underneath paints them.
    const pieces = useMemo(() => (commands && wantsCommands ? commandPieces(text, commands, codex) : []), [text, commands, wantsCommands, codex])
    const painted = pieces.some((piece) => piece.command)
    useLayoutEffect(() => {
        if (backdrop.current && box.current) backdrop.current.scrollTop = box.current.scrollTop
    })
    const menuOpen = trigger !== null && choices.length > 0
    const selected = Math.min(menuIndex, Math.max(0, choices.length - 1))
    useEffect(() => setMenuIndex(0), [trigger?.kind, trigger?.query])
    useEffect(() => {
        if (menuOpen) document.getElementById(`chat-menu-${sessionId}-${selected}`)?.scrollIntoView({ block: 'nearest' })
    }, [menuOpen, selected, sessionId])

    const choose = (choice: ChatCommand | string): void => {
        if (!trigger) return
        const caretAt = Math.min(caret, text.length)
        const inserted = typeof choice === 'string' ? `${fileMention(choice)} ` : `${choice.trigger ?? '/'}${choice.name} `
        if (typeof choice !== 'string') bumpUsage(choice.name)
        const next = `${text.slice(0, trigger.start)}${inserted}${text.slice(caretAt)}`
        setDraft(next, trigger.start + inserted.length)
    }

    // ---- sending ---------------------------------------------------------------------------
    const ready = attachments.filter((item) => item.state === 'ready' && item.path)
    const attaching = attachments.some((item) => item.state === 'attaching')
    const message = [ready.map((item) => fileMention(item.path!)).join(' '), text].filter((part) => part.trim()).join(ready.length > 0 && text ? ' ' : '')
    const over = message.length - MAX_CHAT_TEXT_LENGTH
    const empty = !message.trim()
    const showStop = working && text.trim() === '' && attachments.length === 0

    /**
     * The box empties at once, so the next message can be typed while this one is typed into the
     * terminal (main queues it behind). A refused message comes back into the box, if still empty.
     */
    const send = async (override?: string, options?: ChatSendOptions): Promise<void> => {
        const outgoing = override ?? message
        if (!outgoing.trim() || (override === undefined && (attaching || over > 0))) return
        const taken = override === undefined ? { text, attachments } : null
        // dictated words in the box: the log keeps the box as sent next to what was heard
        const dictated = taken ? dictation.takeForSend() : []
        if (taken) {
            setDraft('')
            setAttachments([])
        }
        setSending((count) => count + 1)
        setNotice(null)
        setBusyDraft(null)
        let result: ChatSendResult
        try {
            result = await onSend(outgoing, options)
        } catch (error) {
            result = { status: 'rejected', reason: 'not_running', message: error instanceof Error ? error.message : String(error) }
        }
        setSending((count) => count - 1)
        if (result.status === 'rejected') {
            if (result.reason === 'input_busy' && result.draft !== undefined) setBusyDraft(result.draft)
            else setNotice({ tone: 'error', text: result.message })
            if (taken && textRef.current === '' && attachmentsRef.current.length === 0) {
                dictation.restore(dictated)
                setDraft(taken.text, taken.text.length)
                setAttachments(taken.attachments)
            }
            // refused and the box holds other text: those words went nowhere (the log counts them discarded)
            return
        }
        dictation.sent(dictated, taken?.text ?? outgoing)
        if (result.status === 'queued') setNotice({ tone: 'info', text: `${agentName} is working — it gets this when the turn ends.` })
    }

    /** one quick reply at a time: taps on any chip wait until the Mac has answered the first */
    const sendQuick = async (reply: string): Promise<void> => {
        if (quickInFlightRef.current !== null) return
        quickInFlightRef.current = reply
        setQuickInFlight(reply)
        try {
            await send(reply)
        } finally {
            quickInFlightRef.current = null
            setQuickInFlight(null)
        }
    }

    const stop = async (): Promise<void> => {
        const refused = await onInterrupt()
        setNotice(refused ? { tone: 'error', text: refused } : null)
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        // IME composition (Korean, Japanese): Enter confirms the character, it does not send.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
        // listening: the box is read-only. Enter stops and keeps the words (nothing is sent); Esc takes them back out
        if (dictation.active) {
            if (event.key === 'Enter' || event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                if (event.key === 'Escape') dictation.cancel()
                else dictation.stop()
            }
            return
        }
        if (menuOpen) {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault()
                const step = event.key === 'ArrowDown' ? 1 : -1
                setMenuIndex((selected + step + choices.length) % choices.length)
                return
            }
            if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
                event.preventDefault()
                const choice = choices[selected]
                if (choice !== undefined) choose(choice)
                return
            }
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                setMenuDismissed(true)
                return
            }
        }
        const modifier = event.metaKey || event.ctrlKey
        // a phone keyboard's Return has no Shift: on touch it breaks the line, the Send button sends
        // a phone may choose Return to send (its own setting — 69340cc2)
        const enterSends = touch ? preferences.returnSendsOnTouch === true : preferences.enterSends !== false
        const shouldSend = event.key === 'Enter' && !event.shiftKey && (modifier || (enterSends && !event.altKey))
        // a number typed for the card waits: the empty box's Enter confirms it, Escape cancels it
        if (pendingPick && text.trim() === '') {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onCancelPick()
                return
            }
            // an empty box has no line to break: Return confirms on a touch screen too
            if (shouldSend || (touch && event.key === 'Enter' && !event.shiftKey)) {
                event.preventDefault()
                if (!event.repeat) onConfirmPick()
                return
            }
        }
        if (event.key === 'Escape' && working) {
            event.preventDefault()
            event.stopPropagation()
            void stop()
            return
        }
        if (!shouldSend) return
        event.preventDefault()
        if (event.repeat) return
        submit()
    }

    /**
     * Enter and the Send button do the same: a question on screen takes a typed number as its option
     * (the empty box then confirms it); anything else waits for the answer. On a phone Return breaks
     * the line, so the button is the only way to pick by number.
     */
    const submit = (): void => {
        if (pendingPick && text.trim() === '') {
            onConfirmPick()
            return
        }
        if (promptOptions) {
            const number = /^\s*(\d{1,2})\s*$/.exec(text)?.[1]
            if (number && promptOptions.includes(Number(number))) {
                onPick(Number(number))
                setDraft('')
                return
            }
            setNotice({ tone: 'error', text: 'Answer the question above first — click an option or type its number.' })
            return
        }
        void send()
    }

    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        const pasted = Array.from(event.clipboardData.items)
            .filter((item) => item.kind === 'file')
            .map((item) => item.getAsFile())
            .filter((file): file is File => file !== null)
        if (pasted.length > 0) {
            event.preventDefault()
            addFiles(pasted)
            return
        }
        const incoming = event.clipboardData.getData('text')
        const element = event.currentTarget
        const room = MAX_CHAT_TEXT_LENGTH - (element.value.length - (element.selectionEnd - element.selectionStart))
        if (incoming.length > room) {
            setNotice({ tone: 'error', text: `${(incoming.length - room).toLocaleString()} characters of the paste did not fit: a message holds ${MAX_CHAT_TEXT_LENGTH.toLocaleString()}.` })
        }
    }

    const quickReplies = (preferences.quickReplies ?? DEFAULT_QUICK_REPLIES).filter((reply) => reply.trim())
    // also while the agent works: a tap then waits for the turn to end, as a typed message does
    const showQuick = preferences.showQuickReplies === true && !promptOptions && text === '' && attachments.length === 0 && quickReplies.length > 0
    const hint =
        attaching
            ? 'Attaching…'
            : over > 0
              ? `${over.toLocaleString()} characters over the limit`
              : message.length > MAX_CHAT_TEXT_LENGTH * NEAR_LIMIT
                ? `${(MAX_CHAT_TEXT_LENGTH - message.length).toLocaleString()} characters left`
                : null
    const placeholder = dictation.active
        ? 'Listening… Enter keeps the words · Esc discards them'
        : pendingPick
        ? 'Enter confirms the option above · Esc cancels'
        : promptOptions
          ? // short: the longer words broke onto a second line the one-row box cuts off at 390
            touch
              ? 'Type a number, or tap above'
              : 'Type a number, or click above'
          : messagePlaceholder ?? (touch
            ? `Message ${agentName}`
            : preferences.enterSends === false
            ? `Message ${agentName} (⌘Enter to send)`
            : `Message ${agentName} (Enter to send)`)

    return (
        <div
            className={`chat-composer${dragging ? ' is-dragging' : ''}`}
            onDragOver={(event) => {
                if (!event.dataTransfer.types.includes('Files')) return
                event.preventDefault()
                setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
                if (event.dataTransfer.files.length === 0) return
                event.preventDefault()
                // the chat around it also takes a drop (anywhere on the chat): once is one attachment
                event.stopPropagation()
                setDragging(false)
                addFiles(Array.from(event.dataTransfer.files))
            }}
        >
            {showQuick && (
                <div className="chat-quick" role="group" aria-label="Quick replies" data-testid="chat-quick-replies" aria-busy={quickInFlight !== null}>
                    {quickReplies.map((reply) => (
                        <button
                            key={reply}
                            type="button"
                            className={`chat-quick-reply${quickInFlight === reply ? ' is-sending' : ''}`}
                            title={quickInFlight === reply ? 'Sending…' : `Send “${reply}”`}
                            disabled={quickInFlight !== null}
                            data-sending={quickInFlight === reply ? 'true' : undefined}
                            onClick={() => void sendQuick(reply)}
                        >
                            {quickInFlight === reply && <Loader2 size={11} className="animate-spin chat-quick-spin" aria-hidden="true" />}
                            {reply}
                        </button>
                    ))}
                </div>
            )}
            {busyDraft !== null && (
                <InputBusyNote
                    key={busyDraft}
                    draft={busyDraft}
                    onClearAndSend={() => void send(undefined, { clearDraft: busyDraft })}
                    onDismiss={() => setBusyDraft(null)}
                />
            )}
            {notice && (
                <p className={`chat-composer-note${notice.tone === 'error' ? ' is-error' : ''}`} role={notice.tone === 'error' ? 'alert' : 'status'} data-testid="chat-composer-note">
                    {notice.tone === 'error' && <AlertTriangle size={12} aria-hidden="true" />} {notice.text}
                </p>
            )}
            {menuOpen && trigger && (
                <div className="chat-complete" role="listbox" aria-label={trigger.kind === 'slash' ? 'Commands' : 'Files'} data-testid="chat-complete">
                    {choices.map((choice, index) => {
                        const isCommand = typeof choice !== 'string'
                        return (
                            <button
                                key={isCommand ? `${choice.trigger ?? '/'}${choice.name}` : choice}
                                id={`chat-menu-${sessionId}-${index}`}
                                type="button"
                                role="option"
                                aria-selected={index === selected}
                                className={`chat-complete-row${index === selected ? ' is-selected' : ''}`}
                                data-testid="chat-complete-row"
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseEnter={() => setMenuIndex(index)}
                                onClick={() => choose(choice)}
                            >
                                {isCommand ? (
                                    <>
                                        <span className="chat-complete-name">
                                            {choice.trigger ?? '/'}
                                            {choice.name}
                                        </span>
                                        <span className="chat-complete-description">{choice.description}</span>
                                        <span className="chat-complete-source">{choice.terminal === 'always' ? 'terminal' : SOURCE_LABEL[choice.source]}</span>
                                    </>
                                ) : (
                                    <>
                                        <FileText size={12} aria-hidden="true" />
                                        <span className="chat-complete-name">{choice}</span>
                                    </>
                                )}
                            </button>
                        )
                    })}
                </div>
            )}
            <div className="chat-composer-card">
                {attachments.length > 0 && (
                    <div className="chat-attachments" aria-label="Attached files" data-testid="chat-attachments">
                        {attachments.map((item) => (
                            <div key={item.id} className={`chat-attachment is-${item.state}`} data-testid="chat-attachment" data-state={item.state} title={item.error ?? item.path ?? item.name}>
                                {item.previewUrl ? <img src={item.previewUrl} alt="" /> : <FileText size={14} aria-hidden="true" />}
                                <span className="chat-attachment-name">{item.name}</span>
                                {item.state === 'attaching' && <Loader2 size={11} className="animate-spin" aria-label="Attaching" />}
                                {item.state === 'error' && <AlertTriangle size={11} className="text-red-400" aria-label="Failed" />}
                                <button type="button" aria-label={`Remove ${item.name}`} title="Remove" onClick={() => removeAttachment(item.id)}>
                                    <X size={11} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
                <div className="chat-composer-row">
                    <div className="chat-composer-input">
                    {painted && (
                        // translate="no": Chrome's page translation rewrites this copy but not the textarea's value — the
                        // box then shows words that are not what gets sent (Galaxy M23, fb-1106)
                        <div ref={backdrop} className="chat-composer-backdrop notranslate" translate="no" aria-hidden="true" data-testid="chat-composer-backdrop">
                            {pieces.map((piece, index) =>
                                piece.command ? (
                                    <span key={index} className="chat-composer-token" data-testid="chat-composer-token">
                                        {piece.text}
                                    </span>
                                ) : (
                                    piece.text
                                )
                            )}
                            {/* a last empty line takes up room in a textarea, not in a div */}
                            {text.endsWith('\n') && '\u200b'}
                        </div>
                    )}
                    <textarea
                        ref={box}
                        rows={1}
                        value={text}
                        maxLength={MAX_CHAT_TEXT_LENGTH}
                        data-testid="chat-composer"
                        className={painted ? 'is-painted' : undefined}
                        data-command={painted ? 'true' : undefined}
                        onScroll={(event) => {
                            if (backdrop.current) backdrop.current.scrollTop = event.currentTarget.scrollTop
                        }}
                        placeholder={placeholder}
                        title={touch ? (preferences.returnSendsOnTouch === true ? 'Return sends' : 'Return starts a new line · the arrow sends') : preferences.enterSends === false ? '⌘Enter sends · Enter starts a new line' : 'Enter sends · Shift+Enter starts a new line'}
                        onChange={(event) => {
                            setDraft(event.target.value)
                            setCaret(event.target.selectionStart)
                            if (notice?.tone === 'error') setNotice(null)
                        }}
                        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                        readOnly={dictation.active}
                        data-dictating={dictation.active ? 'true' : undefined}
                    />
                    </div>
                    {showStop ? (
                        <button
                            type="button"
                            className="chat-composer-send is-stop"
                            data-testid="chat-stop"
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={() => void stop()}
                            title="Stop the agent (Esc)"
                            aria-label="Stop the agent"
                        >
                            <Square size={12} fill="currentColor" />
                        </button>
                    ) : (
                        <button
                            type="button"
                            className="chat-composer-send"
                            data-testid="chat-send"
                            disabled={attaching || over > 0 || dictation.active || (empty && !pendingPick)}
                            onPointerDown={(event) => event.preventDefault()}
                            onClick={submit}
                            title={touch ? 'Send' : preferences.enterSends === false ? 'Send (⌘Enter)' : 'Send (Enter)'}
                            aria-label="Send"
                        >
                            {sending > 0 && empty ? <Loader2 size={14} className="animate-spin" /> : <ArrowUp size={15} />}
                        </button>
                    )}
                </div>
                <div className="chat-composer-status">
                    <input
                        ref={picker}
                        type="file"
                        multiple
                        hidden
                        data-testid="chat-attach-input"
                        onChange={(event) => {
                            const picked = Array.from(event.currentTarget.files ?? [])
                            event.currentTarget.value = ''
                            addFiles(picked)
                        }}
                    />
                    <button type="button" className="chat-meta-chip is-icon" data-testid="chat-attach" title="Attach files (or paste / drop them)" aria-label="Attach files" onClick={() => picker.current?.click()}>
                        <Plus size={13} />
                    </button>
                    <DictationButton controls={dictation} />
                    {status}
                    {hint && (
                        <span className={`chat-composer-hint${over > 0 ? ' is-over' : ''}`} data-testid="chat-composer-hint">
                            {hint}
                        </span>
                    )}
                </div>
            </div>
            {dragging && <div className="chat-drop-hint">Drop files to attach</div>}
        </div>
    )
})
