import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react'
import { AlertTriangle, ArrowUp, FileText, Loader2, Plus, Square, X } from 'lucide-react'
import type { ChatCommand, ChatPreferences, ChatSendOptions, ChatSendResult, ChatTransport } from '../../../../shared/conversation'
import { InputBusyNote } from './InputBusyNote'
import { DEFAULT_QUICK_REPLIES, MAX_CHAT_TEXT_LENGTH } from '../../../../shared/conversation'
import { activeTrigger, fileMention, type Trigger } from './chatLib'

/**
 * A draft per session, kept while the app runs and across restarts
 * (localStorage `chat-drafts`) — switching sessions or views never loses one.
 */
const DRAFTS_KEY = 'chat-drafts'
const drafts: Record<string, string> = (() => {
    try {
        const parsed = JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') as unknown
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
    } catch {
        return {}
    }
})()

function saveDraft(sessionId: string, text: string): void {
    if (text) drafts[sessionId] = text
    else delete drafts[sessionId]
    try {
        localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
    } catch {
        // storage blocked: the draft still lives in memory
    }
}

/**
 * Puts text after `sessionId`'s saved draft without showing it: a queued message withdrawn for Edit
 * after the view moved to another session goes back to its own session, not into the box on
 * screen (round2 N01).
 */
export function appendDraft(sessionId: string, text: string): void {
    const current = drafts[sessionId] ?? ''
    saveDraft(sessionId, current.trim() ? `${current}\n${text}` : text)
}

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
/** Rows the completion menu lists at most. */
const MENU_ROWS = 40
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

function rankCommands(commands: ChatCommand[], trigger: Extract<Trigger, { kind: 'slash' }>, usage: Record<string, number>): ChatCommand[] {
    const query = trigger.query.toLowerCase()
    const wanted = commands.filter((command) => (trigger.prefix === '$' ? command.trigger === '$' : command.trigger !== '$'))
    const scored = wanted
        .map((command) => {
            const name = command.name.toLowerCase()
            const score = query === '' ? 1 : name.startsWith(query) ? 3 : name.split(/[:-]/).some((word) => word.startsWith(query)) ? 2 : name.includes(query) ? 1 : 0
            return { command, score }
        })
        .filter(({ score }) => score > 0)
    scored.sort(
        (a, b) =>
            b.score - a.score ||
            (usage[b.command.name] ?? 0) - (usage[a.command.name] ?? 0) ||
            Number(a.command.source === 'builtin') - Number(b.command.source === 'builtin') ||
            a.command.name.localeCompare(b.command.name)
    )
    return scored.slice(0, MENU_ROWS).map(({ command }) => command)
}

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
    { sessionId, transport, agentName, codex, working, promptOptions, pendingPick, onPick, onConfirmPick, onCancelPick, preferences, touch = false, onSend, onInterrupt, status },
    ref
) {
    const [text, setText] = useState(() => drafts[sessionId] ?? '')
    const [caret, setCaret] = useState(0)
    /** messages on their way into the terminal */
    const [sending, setSending] = useState(0)
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
    const picker = useRef<HTMLInputElement>(null)
    const attachmentsRef = useRef<Attachment[]>([])
    attachmentsRef.current = attachments
    const textRef = useRef(text)
    textRef.current = text

    useEffect(() => {
        setText(drafts[sessionId] ?? '')
        setNotice(null)
        setBusyDraft(null)
        setCommands(null)
        setAttachments([])
        // The terminal under the chat may still hold focus: keys would go to it unseen.
        // Take focus only from it (or from nothing), never from another input.
        // A touch screen: focus raises the soft keyboard over the chat the user came to read — leave it.
        if (touch) return
        const timer = window.setTimeout(() => {
            const active = document.activeElement
            const terminal = active?.closest?.(`[data-session-id="${CSS.escape(sessionId)}"]`)
            if (!active || active === document.body || (terminal && active.closest('.xterm'))) box.current?.focus()
        }, FOCUS_DELAY_MS)
        return () => window.clearTimeout(timer)
    }, [sessionId])

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
            }
        }),
        [addFiles, setDraft, text, sessionId]
    )

    // ---- completion menu -------------------------------------------------------------------
    const trigger = menuDismissed ? null : activeTrigger(text, caret, codex)
    useEffect(() => {
        if (trigger?.kind !== 'slash' || commands !== null) return
        let live = true
        void transport
            .listCommands(sessionId)
            .then((list) => live && setCommands(list))
            .catch(() => live && setCommands([]))
        return () => {
            live = false
        }
    }, [trigger?.kind, commands, sessionId, transport])

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
                setDraft(taken.text, taken.text.length)
                setAttachments(taken.attachments)
            }
            return
        }
        if (result.status === 'queued') setNotice({ tone: 'info', text: `${agentName} is working — it gets this when the turn ends.` })
    }

    const stop = async (): Promise<void> => {
        const refused = await onInterrupt()
        setNotice(refused ? { tone: 'error', text: refused } : null)
    }

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        // IME composition (Korean, Japanese): Enter confirms the character, it does not send.
        if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return
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
        const enterSends = !touch && preferences.enterSends !== false
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
    const showQuick = preferences.showQuickReplies === true && !working && !promptOptions && text === '' && attachments.length === 0 && quickReplies.length > 0
    const hint =
        attaching
            ? 'Attaching…'
            : over > 0
              ? `${over.toLocaleString()} characters over the limit`
              : message.length > MAX_CHAT_TEXT_LENGTH * NEAR_LIMIT
                ? `${(MAX_CHAT_TEXT_LENGTH - message.length).toLocaleString()} characters left`
                : null
    const placeholder = pendingPick
        ? 'Enter confirms the option above · Esc cancels'
        : promptOptions
          ? touch
              ? 'Type an option’s number, or tap it above'
              : 'Type an option’s number, or click it above'
          : touch
            ? `Message ${agentName}`
            : preferences.enterSends === false
            ? `Message ${agentName} (⌘Enter to send)`
            : `Message ${agentName} (Enter to send)`

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
                <div className="chat-quick" role="group" aria-label="Quick replies" data-testid="chat-quick-replies">
                    {quickReplies.map((reply) => (
                        <button key={reply} type="button" className="chat-quick-reply" title={`Send “${reply}”`} onClick={() => void send(reply)}>
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
                    <textarea
                        ref={box}
                        rows={1}
                        value={text}
                        maxLength={MAX_CHAT_TEXT_LENGTH}
                        data-testid="chat-composer"
                        placeholder={placeholder}
                        title={touch ? 'Return starts a new line · the arrow sends' : preferences.enterSends === false ? '⌘Enter sends · Enter starts a new line' : 'Enter sends · Shift+Enter starts a new line'}
                        onChange={(event) => {
                            setDraft(event.target.value)
                            setCaret(event.target.selectionStart)
                            if (notice?.tone === 'error') setNotice(null)
                        }}
                        onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                        onKeyDown={onKeyDown}
                        onPaste={onPaste}
                    />
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
                            disabled={attaching || over > 0 || (empty && !pendingPick)}
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
