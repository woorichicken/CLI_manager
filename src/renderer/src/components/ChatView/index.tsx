import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, Clock, CornerRightUp, Loader2, Terminal as TerminalIcon } from 'lucide-react'
import type { ChatCommand, ChatPreferences, ChatSendOptions, ChatSendResult, ChatTransport, ConversationAgent, ConversationSnapshot } from '../../../../shared/conversation'
import { CHAT_TURN_LIMIT } from '../../../../shared/conversation'
import { ChatTurn } from './ChatTurn'
import { endedOnAnswer } from './workBlocks'
import { appendDraft, Composer, type ComposerHandle } from './Composer'
import { ArtifactsChip, ContextChip, ModeChip, ModelChip, PlanChip } from './ComposerChips'
import { ImageLightbox } from './ChatImages'
import { PromptCard } from './PromptCard'
import { QueuedMessages } from './QueuedMessages'
import { useConversation } from './useConversation'
import { useElapsed } from './WorkBlock'
import { ChatActionsContext, onChatCommand, type ChatActions, type GalleryImage } from './chatContext'
import { artifactLinks, fileLineTarget, INTERRUPTED_TEXT, isCommandText, latestTodos, resolveChatPath, terminalCommand } from './chatLib'
import './chat.css'

/**
 * The Chat view: the same session as its terminal, read from the agent's own
 * transcript — the person's messages, the answers (Markdown, tables, colored
 * code), each turn's work folded under one row, "working" while a turn runs,
 * the agent's question as a card, and a box to send the next message. The
 * terminal keeps running underneath; "Terminal" in the header goes back to it.
 *
 * Talks to the app only through `transport` (no `window.api` in this folder):
 * the Electron app passes IPC, a phone page can pass HTTP.
 */
export interface ChatViewProps {
    sessionId: string
    transport: ChatTransport
    /** `command` names what was sent when a command only the terminal can show opened it */
    onOpenTerminal: (command?: string) => void
    fontSize?: number
    preferences?: ChatPreferences
    /**
     * A touch screen (the phone page): Return breaks the line and the Send button sends, and opening a
     * chat does not take the keyboard — as ovis on a phone (Composer.tsx:274-276, docs/guide.md:963).
     */
    touch?: boolean
    /**
     * A device paired view-only (the phone's `watch` role): the conversation is shown, and where the box
     * would be one line says why there is none — the server refuses its sends anyway (403 view_only).
     */
    readOnly?: boolean
    /**
     * Whether `transport.openFile` shows anything. A view-only phone is not given files (decision 0010): there a
     * path the chat names is plain text instead of a button that does nothing (G9).
     */
    canOpenFiles?: boolean
    /**
     * A `climanager://session/…` link the chat shows was clicked: show that session (b2020233). Absent:
     * the link stays words — the same link in the terminal already goes through the app's own handler.
     */
    onSessionLink?: (uri: string) => void
}

/** Within this many pixels of the end, new turns keep the view pinned to the bottom. */
const STICK_PX = 80
/** "Show earlier" asks for this many more turns. */
const MORE_TURNS = 200
/** A sent message waits faded this long for its turn; a clock joins it after CLOCK_MS. */
const SENT_WAIT_MS = 60_000
const CLOCK_MS = 5_000
/** The agent's clock and this one may differ by a little. */
const CLOCK_SKEW_MS = 10_000
/** The rail of sent messages shows from this many. */
const RAIL_MIN = 4
/** The rail shows the newest this many. */
const RAIL_MAX = 40
/** The rail needs this much room left of the column (ovis: 32px margin). */
const RAIL_MARGIN_PX = 32

const NAMES: Record<ConversationAgent, string> = { claude: 'Claude', codex: 'Codex' }

/**
 * Where each session's chat was scrolled, and how many turns it showed (ovis chatScrollMemory):
 * back to the same place, unless it was at the end. Written on every scroll — on unmount the
 * scroller is already gone.
 */
const scrollMemory = new Map<string, { top: number; pinned: boolean; limit: number }>()

/** Each session's command list, for telling which sent commands open the terminal. */
const commandLists = new Map<string, Promise<ChatCommand[]>>()
function commandsFor(transport: ChatTransport, sessionId: string): Promise<ChatCommand[]> {
    let list = commandLists.get(sessionId)
    if (!list) {
        list = transport.listCommands(sessionId).catch(() => [])
        commandLists.set(sessionId, list)
    }
    return list
}

interface SentWaiting {
    id: number
    text: string
    at: number
}
let sentSequence = 0

export function ChatView({ sessionId, transport, onOpenTerminal, fontSize = 14, preferences = {}, touch = false, readOnly = false, canOpenFiles = true, onSessionLink }: ChatViewProps) {
    const [limit, setLimit] = useState(() => scrollMemory.get(sessionId)?.limit ?? CHAT_TURN_LIMIT)
    const { snapshot, refresh } = useConversation(transport, sessionId, limit)
    const scroller = useRef<HTMLDivElement>(null)
    const column = useRef<HTMLDivElement>(null)
    const composer = useRef<ComposerHandle>(null)
    const pinned = useRef(true)
    const limitRef = useRef(limit)
    limitRef.current = limit
    const [showJump, setShowJump] = useState(false)
    const [sent, setSent] = useState<SentWaiting[]>([])
    const [now, setNow] = useState(() => Date.now())
    const [picked, setPicked] = useState<number | null>(null)
    const [gallery, setGallery] = useState<{ images: GalleryImage[]; index: number } | null>(null)
    const [railRoom, setRailRoom] = useState(false)
    /** the person's last message has scrolled off the top (edf2aef3) */
    const [lastAbove, setLastAbove] = useState(false)
    const lastSaidIndex = useRef<number | null>(null)
    const measureLastSaid = useCallback((): void => {
        const element = scroller.current
        const index = lastSaidIndex.current
        const turn = index === null ? null : element?.querySelector(`[data-turn-index="${index}"]`)
        setLastAbove(Boolean(element && turn && turn.getBoundingClientRect().bottom <= element.getBoundingClientRect().top))
    }, [])

    // Opening a chat starts where it was left, or at its end.
    useEffect(() => {
        const remembered = scrollMemory.get(sessionId)
        pinned.current = remembered?.pinned ?? true
        setLimit(remembered?.limit ?? CHAT_TURN_LIMIT)
        setSent([])
        setPicked(null)
        setGallery(null)
    }, [sessionId])

    const restored = useRef<string | null>(null)
    useLayoutEffect(() => {
        const element = scroller.current
        if (!element || !snapshot) return
        if (restored.current !== sessionId) {
            restored.current = sessionId
            const remembered = scrollMemory.get(sessionId)
            if (remembered && !remembered.pinned) {
                element.scrollTop = remembered.top
                setShowJump(true)
                return
            }
        }
        if (pinned.current) element.scrollTop = element.scrollHeight
    }, [snapshot, sent, sessionId])

    const onScroll = (): void => {
        const element = scroller.current
        if (!element) return
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX
        pinned.current = atBottom
        setShowJump(!atBottom)
        measureLastSaid()
        scrollMemory.set(sessionId, { top: element.scrollTop, pinned: atBottom, limit: limitRef.current })
    }

    const jumpToEnd = (): void => {
        const element = scroller.current
        if (!element) return
        element.scrollTop = element.scrollHeight
        pinned.current = true
        setShowJump(false)
    }

    /** One page, keeping one line of the last page in view (ovis pageScrollDistance). */
    const page = useCallback((direction: 1 | -1): void => {
        const element = scroller.current
        if (!element) return
        const line = parseFloat(getComputedStyle(element).lineHeight) || 20
        element.scrollTop += direction * Math.max(1, element.clientHeight - line)
        onScroll()
    }, [sessionId])

    // The app's shortcuts reach this session's chat through the bus (App → sendChatCommand).
    useEffect(
        () =>
            onChatCommand(sessionId, (command) => {
                if (command === 'focus') composer.current?.focus()
                else if (command === 'dictation') composer.current?.toggleDictation()
                else page(command === 'pageUp' ? -1 : 1)
            }),
        [sessionId, page]
    )

    // The rail needs room beside the column.
    useLayoutEffect(() => {
        const element = scroller.current
        if (!element || typeof ResizeObserver === 'undefined') return
        const measure = (): void => {
            const columnWidth = column.current?.getBoundingClientRect().width ?? 0
            setRailRoom((element.clientWidth - columnWidth) / 2 >= RAIL_MARGIN_PX)
        }
        measure()
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
    }, [])

    // A sent message waits faded until its turn is written, at most a minute.
    useEffect(() => {
        if (sent.length === 0) return
        const timer = window.setInterval(() => setNow(Date.now()), 1000)
        return () => window.clearInterval(timer)
    }, [sent.length])
    useEffect(() => {
        if (!snapshot || sent.length === 0) return
        // a user turn with the same words, written after it was sent (a clock a few seconds off still counts)
        const written = snapshot.turns
            .filter((turn) => turn.role === 'user')
            .flatMap((turn) => turn.parts.flatMap((part) => (part.kind === 'text' ? [{ text: part.text.trim(), at: turn.ts ? Date.parse(turn.ts) : NaN }] : [])))
        const arrived = (item: SentWaiting): boolean =>
            written.some((turn) => turn.text === item.text.trim() && (!Number.isFinite(turn.at) || turn.at >= item.at - CLOCK_SKEW_MS))
        setSent((current) => {
            const next = current.filter((item) => !arrived(item) && now - item.at < SENT_WAIT_MS)
            return next.length === current.length ? current : next
        })
    }, [snapshot, sent.length, now])

    // A picked number belongs to one menu.
    const signature = snapshot?.prompt?.signature ?? null
    useEffect(() => setPicked(null), [signature])

    // A terminal-only `/` command typed off the queue (main names it, F18): show the terminal, as
    // `sendText` does for one sent at once. The one already named when this session's chat opened
    // went out before — it is only noted.
    const seenOpened = useRef<{ session: string; id: string | null } | null>(null)
    const openedId = snapshot?.sessionId === sessionId ? snapshot.terminalOpened?.id ?? null : undefined
    const openedCommand = snapshot?.terminalOpened?.command
    useEffect(() => {
        if (openedId === undefined) return
        if (seenOpened.current?.session !== sessionId) {
            seenOpened.current = { session: sessionId, id: openedId }
            return
        }
        if (openedId === null || openedId === seenOpened.current.id) return
        seenOpened.current = { session: sessionId, id: openedId }
        onOpenTerminal(openedCommand)
    }, [openedId, openedCommand, onOpenTerminal, sessionId])

    const cwd = snapshot?.cwd
    const home = snapshot?.home
    const actions = useMemo<ChatActions>(
        () => ({
            sessionId,
            transport,
            openPath: (target: string) => {
                const { path, line } = fileLineTarget(target)
                transport.openFile(sessionId, resolveChatPath(path, cwd, home), line ?? undefined)
            },
            canOpenPaths: canOpenFiles,
            openSessionLink: onSessionLink,
            openGallery: (images, index) => setGallery({ images, index })
        }),
        [sessionId, transport, cwd, home, canOpenFiles, onSessionLink]
    )

    const sendText = useCallback(
        async (text: string, options?: ChatSendOptions): Promise<ChatSendResult> => {
            // the person's words show at once, faded, while they are typed into the terminal
            const bubble = isCommandText(text) ? null : { id: ++sentSequence, text, at: Date.now() }
            if (bubble) {
                pinned.current = true
                setSent((current) => [...current, bubble])
            }
            const result = await transport.send(sessionId, text, options)
            // refused, or waiting in the queue (shown there): not on its way
            if (bubble && result.status !== 'sent') setSent((current) => current.filter((item) => item.id !== bubble.id))
            if (result.status === 'sent' && !bubble) {
                const command = terminalCommand(text, await commandsFor(transport, sessionId))
                if (command) onOpenTerminal(command)
            }
            refresh()
            return result
        },
        [onOpenTerminal, refresh, sessionId, transport]
    )

    const interrupt = useCallback(async (): Promise<string | null> => {
        try {
            const result = await transport.interrupt(sessionId)
            refresh()
            return result.status === 'stopped' ? null : result.message
        } catch (error) {
            return error instanceof Error ? error.message : String(error)
        }
    }, [refresh, sessionId, transport])

    const confirmPick = useCallback(async (): Promise<void> => {
        const prompt = snapshot?.prompt
        const option = prompt?.options.find((item) => item.number === picked)
        setPicked(null)
        if (!prompt || !option) return
        await transport.answerPrompt(sessionId, { signature: prompt.signature, optionIndex: option.index }).catch(() => undefined)
        refresh()
    }, [picked, refresh, sessionId, snapshot?.prompt, transport])

    const agent = snapshot?.agent ?? null
    const agentName = agent ? NAMES[agent] : 'the agent'
    const prompt = snapshot?.prompt ?? null
    const turns = snapshot?.turns ?? []
    // held a moment: Claude Code 2.1.318 hides its spinner row while an answer streams in, so the
    // screen says «not working» for a second or two mid-turn — the row would blink (4359b4ee). Not once
    // the turn has written its final answer: then it is over, and the row goes at once.
    const lastTurn = turns.at(-1)
    const settled = lastTurn?.role === 'assistant' && endedOnAnswer(lastTurn)
    const heldWorking = useHeldTrue(Boolean(snapshot?.working && !prompt), WORKING_HOLD_MS)
    const working = (snapshot?.working || !settled ? heldWorking : false) && !prompt
    const todos = useMemo(() => latestTodos(turns), [turns])
    const artifacts = useMemo(() => artifactLinks(turns), [turns])
    const lastUser = useMemo(() => {
        for (let index = turns.length - 1; index >= 0; index--) if (turns[index].role === 'user') return turns[index].ts
        return null
    }, [turns])
    const elapsed = useElapsed(working ? lastUser : null)
    const promptOptions = prompt ? (prompt.answerable ? prompt.options.flatMap((option) => (option.number !== null && !option.custom ? [option.number] : [])) : []) : null

    const rail = useMemo(
        () =>
            turns.flatMap((turn, index) => {
                if (turn.role !== 'user') return []
                const words = turn.parts.flatMap((part) => (part.kind === 'text' && !INTERRUPTED_TEXT.test(part.text.trim()) ? [part.text] : [])).join(' ')
                return words ? [{ index, words }] : []
            }),
        [turns]
    )
    const lastSaid = preferences.pinLastMessage === true ? rail.at(-1) ?? null : null
    lastSaidIndex.current = lastSaid?.index ?? null
    // runs after the scroll position above is settled (useLayoutEffect, in order)
    useLayoutEffect(measureLastSaid, [measureLastSaid, snapshot, sessionId, lastSaid?.index])
    const jumpTo = (index: number): void => {
        const target = scroller.current?.querySelector(`[data-turn-index="${index}"]`)
        if (!target) return
        pinned.current = false
        target.scrollIntoView({ block: 'start' })
    }

    return (
        <ChatActionsContext.Provider value={actions}>
            <div
                className="chat-view"
                data-testid="chat-view"
                data-session-id={sessionId}
                data-touch={touch ? 'true' : undefined}
                style={{ fontSize: `${fontSize}px` }}
                onKeyDownCapture={(event) => {
                    // plain PageUp/PageDown read the chat, even from the message box (its draft and caret stay)
                    if ((event.key === 'PageUp' || event.key === 'PageDown') && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
                        event.preventDefault()
                        page(event.key === 'PageUp' ? -1 : 1)
                    }
                }}
                onDragOver={(event) => {
                    if (event.dataTransfer.types.includes('Files')) event.preventDefault()
                }}
                onDrop={(event) => {
                    if (event.dataTransfer.files.length === 0) return
                    event.preventDefault()
                    composer.current?.addFiles(Array.from(event.dataTransfer.files))
                }}
            >
                {railRoom && rail.length >= RAIL_MIN && (
                    <nav className="chat-rail" aria-label="Your messages" data-testid="chat-rail">
                        {rail.slice(-RAIL_MAX).map((item) => (
                            <button key={item.index} type="button" className="chat-rail-dash" data-testid="chat-rail-dash" title={item.words.slice(0, 120)} aria-label={`Go to: ${item.words.slice(0, 60)}`} onClick={() => jumpTo(item.index)} />
                        ))}
                    </nav>
                )}
                {lastSaid && lastAbove && (
                    <button type="button" className="chat-pinned-last" data-testid="chat-pinned-last" title="Go to your last message" onClick={() => jumpTo(lastSaid.index)}>
                        <CornerRightUp size={12} aria-hidden="true" />
                        <span className="chat-pinned-last-text">{lastSaid.words}</span>
                    </button>
                )}
                <div className="chat-scroll" ref={scroller} onScroll={onScroll} data-testid="chat-scroll">
                    <div className="chat-column" ref={column}>
                        {snapshot === null ? (
                            <div className="chat-empty">
                                <Loader2 size={16} className="animate-spin" /> Reading the conversation…
                            </div>
                        ) : snapshot.unavailable === 'not-found' && snapshot.agent !== null ? (
                            // a new Claude session writes its file with the first message: nothing is wrong yet
                            <NoTurnsYet missingFile onOpenTerminal={() => onOpenTerminal()} />
                        ) : snapshot.unavailable ? (
                            <Unavailable snapshot={snapshot} onOpenTerminal={() => onOpenTerminal()} />
                        ) : (
                            <Turns snapshot={snapshot} onShowEarlier={() => (pinned.current = false, setLimit((current) => current + MORE_TURNS))} />
                        )}
                        {sent.length > 0 && (
                            <div className="chat-sent" data-testid="chat-sent-waiting">
                                {sent.map((item) => (
                                    <div key={item.id} className="chat-turn chat-turn-user">
                                        <div className="chat-user-bubble is-sending" data-testid="chat-sent-bubble">
                                            {item.text}
                                            {now - item.at >= CLOCK_MS && <Clock size={11} className="chat-sent-clock" aria-label="Not written yet" data-testid="chat-sent-clock" />}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        {snapshot && (
                            <QueuedMessages
                                sessionId={sessionId}
                                transport={transport}
                                queued={snapshot.queued}
                                agentName={agentName}
                                onEdit={(text, from) => (composer.current ? composer.current.editText(text, from) : appendDraft(from, text))}
                                onChanged={refresh}
                            />
                        )}
                        {working && (
                            <div className="chat-working" data-testid="chat-working">
                                <Loader2 size={13} className="animate-spin text-blue-300" aria-hidden="true" /> {agentName} is working…
                                {elapsed && (
                                    <span className="chat-working-time" data-testid="chat-working-time">
                                        {elapsed}
                                    </span>
                                )}
                                <span className="chat-working-hint">Esc stops</span>
                            </div>
                        )}
                    </div>
                </div>
                {showJump && (
                    <button type="button" className="chat-jump" onClick={jumpToEnd} aria-label="Jump to the latest message">
                        <ArrowDown size={14} />
                    </button>
                )}
                <div className="chat-bottom">
                    <div className="chat-column">
                        {prompt && (
                            <PromptCard
                                sessionId={sessionId}
                                prompt={prompt}
                                transport={transport}
                                onOpenTerminal={() => onOpenTerminal()}
                                onAnswered={refresh}
                                picked={picked}
                                onConfirmPick={() => void confirmPick()}
                                onCancelPick={() => setPicked(null)}
                                readOnly={readOnly}
                            />
                        )}
                        {readOnly ? (
                            <p className="chat-read-only" data-testid="chat-read-only">
                                View only — pair this device again on the Mac with “Code — can type” to write here.
                            </p>
                        ) : (
                        <Composer
                            ref={composer}
                            sessionId={sessionId}
                            transport={transport}
                            agentName={agentName}
                            codex={agent === 'codex'}
                            working={working}
                            promptOptions={promptOptions}
                            pendingPick={picked !== null}
                            onPick={setPicked}
                            onConfirmPick={() => void confirmPick()}
                            onCancelPick={() => setPicked(null)}
                            preferences={preferences}
                            touch={touch}
                            onSend={sendText}
                            onInterrupt={interrupt}
                            status={
                                <>
                                    <PlanChip items={todos} />
                                    <ArtifactsChip links={artifacts} onOpen={(url) => transport.openLink(url)} />
                                    <ModeChip agent={agent} meta={snapshot?.meta ?? null} />
                                    <span className="chat-status-spacer" />
                                    <ModelChip agent={agent} meta={snapshot?.meta ?? null} working={working} onCommand={(text) => void sendText(text)} />
                                    <ContextChip meta={snapshot?.meta ?? null} canCompact={!working && !prompt} onCompact={() => void sendText('/compact')} />
                                </>
                            }
                        />
                        )}
                    </div>
                </div>
                {gallery && <ImageLightbox images={gallery.images} start={gallery.index} onClose={() => setGallery(null)} />}
            </div>
        </ChatActionsContext.Provider>
    )
}

function Turns({ snapshot, onShowEarlier }: { snapshot: ConversationSnapshot; onShowEarlier: () => void }) {
    const agent = snapshot.agent ?? 'claude'
    const hidden = snapshot.totalTurns - snapshot.turns.length
    return (
        <>
            {(snapshot.truncated || hidden > 0) && (
                <div className="chat-older-note" data-testid="chat-older-note">
                    {hidden > 0 ? (
                        <>
                            Showing the last {snapshot.turns.length} of {snapshot.totalTurns} turns.{' '}
                            <button type="button" className="chat-link-button" data-testid="chat-show-earlier" onClick={onShowEarlier}>
                                Show earlier
                            </button>
                        </>
                    ) : (
                        'Earlier turns are not shown — the conversation file is large. Scroll the terminal for them.'
                    )}
                </div>
            )}
            {snapshot.turns.length === 0 && <NoTurnsYet />}
            {snapshot.turns.map((turn, index) => (
                <ChatTurn
                    key={`${snapshot.totalTurns - snapshot.turns.length + index}-${turn.ts ?? ''}`}
                    turn={turn}
                    index={index}
                    last={index === snapshot.turns.length - 1}
                    working={snapshot.working}
                    waiting={snapshot.prompt !== null}
                    agent={agent}
                />
            ))}
        </>
    )
}

/**
 * Nothing said yet: the session is there and its agent waits for a first message. With `missingFile`
 * the agent's conversation file is not there yet either — what a new Claude session looks like until
 * the first message, and also what a deleted file looks like, so the terminal stays one tap away.
 */
function NoTurnsYet({ missingFile = false, onOpenTerminal }: { missingFile?: boolean; onOpenTerminal?: () => void }) {
    return (
        <div className="chat-empty" data-testid="chat-no-turns-yet" data-missing-file={missingFile ? 'true' : undefined}>
            <p>No conversation yet — write your first message below.</p>
            {missingFile && onOpenTerminal && (
                <p className="chat-empty-note">
                    Talked here before?{' '}
                    <button type="button" className="chat-link-button" onClick={onOpenTerminal}>
                        <TerminalIcon size={12} aria-hidden="true" /> Open the terminal
                    </button>
                </p>
            )}
        </div>
    )
}

function Unavailable({ snapshot, onOpenTerminal }: { snapshot: ConversationSnapshot; onOpenTerminal: () => void }) {
    const text =
        snapshot.unavailable === 'no-conversation'
            ? 'No Claude Code or Codex conversation is linked to this session yet. Start claude or codex in the terminal and the chat follows it.'
            : snapshot.unavailable === 'not-found'
              ? 'The conversation file for this session was not found. It may still be starting, or it was deleted.'
              : 'The conversation file could not be read.'
    return (
        <div className="chat-empty" data-testid="chat-unavailable" data-reason={snapshot.unavailable}>
            <p>{text}</p>
            <button type="button" className="chat-link-button" onClick={onOpenTerminal}>
                <TerminalIcon size={12} aria-hidden="true" /> Open the terminal
            </button>
        </div>
    )
}

/** How long «working» outlasts the screen's last spinner row (a streamed answer hides it for ~1.7s, recorded). */
const WORKING_HOLD_MS = 2000

/** `value`, except that a change to false waits `ms` — and is dropped when it turns true again first. */
function useHeldTrue(value: boolean, ms: number): boolean {
    const [held, setHeld] = useState(value)
    useEffect(() => {
        if (value) {
            setHeld(true)
            return
        }
        const timer = window.setTimeout(() => setHeld(false), ms)
        return () => window.clearTimeout(timer)
    }, [value, ms])
    return value || held
}
