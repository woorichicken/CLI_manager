import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw } from 'lucide-react'
import type { AgentConversationItem, AgentConversationList } from '../../../../shared/conversation'
import { MENU_Z_INDEX } from '../../constants/styles'

interface ConnectConversationDialogProps {
    sessionId: string
    sessionName: string
    onClose: () => void
    /** The sidebar keeps the Enter notice visible and focuses this terminal after closing the dialog. */
    onResumePrepared?: (sessionId: string) => void
}

const itemKey = (item: AgentConversationItem): string => `${item.agent}:${item.id}`
const agentName = (agent: string): string => agent === 'codex' ? 'Codex' : 'Claude'
const dateLabel = (at: number): string => new Date(at).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
})

/** An explicit link only changes the conversation; the transcript's words are never terminal input. */
export function ConnectConversationDialog({ sessionId, sessionName, onClose, onResumePrepared }: ConnectConversationDialogProps) {
    const [list, setList] = useState<AgentConversationList | null>(null)
    const [selectedKey, setSelectedKey] = useState('')
    const [loading, setLoading] = useState(true)
    const [connecting, setConnecting] = useState(false)
    const [resumeTyped, setResumeTyped] = useState(false)
    const [error, setError] = useState('')
    const panelRef = useRef<HTMLDivElement>(null)
    const cancelRef = useRef<HTMLButtonElement>(null)
    const mountedRef = useRef(true)
    const closeRef = useRef(onClose)
    const connectingRef = useRef(connecting)
    closeRef.current = onClose
    connectingRef.current = connecting

    const blocked = (item: AgentConversationItem, data = list): boolean => {
        if (!data || item.linkedTo || data.front.kind === 'claude' || data.front.kind === 'unknown') return true
        return data.front.kind === 'codex' &&
            (item.agent !== 'codex' || (!!data.front.runningId && item.id !== data.front.runningId))
    }

    const load = useCallback(async (keepError = false): Promise<void> => {
        setLoading(true)
        if (!keepError) setError('')
        try {
            const response = await window.api.listAgentConversations(sessionId)
            if (!mountedRef.current) return
            if ('error' in response) {
                setError(response.error.message)
                return
            }
            setList(response)
            setSelectedKey((previous) => {
                const available = response.items.filter(item => !blocked(item, response))
                const preferred = available.find(item => itemKey(item) === previous) ??
                    available.find(item => item.id === response.front.runningId && item.agent === response.front.kind) ??
                    available.find(item => item.id === response.current?.id && item.agent === response.current.agent) ??
                    available.find(item => item.startedHere) ?? available[0]
                return preferred ? itemKey(preferred) : ''
            })
        } catch {
            if (mountedRef.current) setError('Could not load conversations. Try again.')
        } finally {
            if (mountedRef.current) setLoading(false)
        }
    }, [sessionId])

    useEffect(() => {
        mountedRef.current = true
        void load()
        return () => { mountedRef.current = false }
    }, [load])

    useEffect(() => {
        const previous = document.activeElement as HTMLElement | null
        cancelRef.current?.focus()
        const onKeyDown = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                if (!connectingRef.current) closeRef.current()
            } else if (event.key === 'Tab') {
                const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), [tabindex="0"]'
                ) ?? [])
                const first = controls[0]
                const last = controls[controls.length - 1]
                if (event.shiftKey && (document.activeElement === first || !panelRef.current?.contains(document.activeElement))) {
                    event.preventDefault()
                    last?.focus()
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault()
                    first?.focus()
                }
            }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => {
            window.removeEventListener('keydown', onKeyDown, true)
            if (previous?.isConnected) previous.focus()
        }
    }, [])

    const selected = list?.items.find(item => itemKey(item) === selectedKey)
    const unverifiedCodex = list?.front.kind === 'codex' && !list.front.runningId
    const force = !!unverifiedCodex && !!selected && !selected.startedHere
    const canConnect = !!selected && !blocked(selected) && !loading && !connecting && !resumeTyped
    const buttonLabel = connecting ? 'Connecting…' : list?.front.kind === 'shell' ? 'Connect & resume' : force ? 'Connect anyway' : 'Connect'

    const connect = async (): Promise<void> => {
        if (!canConnect || !selected || !list) return
        setConnecting(true)
        setError('')
        try {
            const response = await window.api.connectAgentConversation(sessionId, {
                agent: selected.agent,
                id: selected.id,
                resume: list.front.kind === 'shell',
                force
            })
            if (!mountedRef.current) return
            if ('error' in response) {
                setError(response.error.message)
                await load(true)
            } else if (response.typed && !response.resumed) {
                // Preparing the command never presses Enter. The person resumes it in Terminal.
                setResumeTyped(true)
                if (onResumePrepared) onResumePrepared(sessionId)
                else await load(true)
            } else closeRef.current()
        } catch {
            if (mountedRef.current) setError('Could not connect the conversation. Refresh the list and try again.')
        } finally {
            if (mountedRef.current) setConnecting(false)
        }
    }

    return createPortal(
        <div
            className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
            style={{ zIndex: MENU_Z_INDEX }}
            onPointerDown={event => {
                if (event.target === event.currentTarget && !connecting) onClose()
            }}
        >
            <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="connect-conversation-title"
                data-testid="connect-conversation-dialog"
                className="w-full max-w-xl max-h-[85vh] flex flex-col bg-[#1e1e20] border border-white/10 rounded-lg shadow-2xl text-gray-200"
            >
                <div className="px-4 pt-4 pb-3 border-b border-white/10">
                    <h2 id="connect-conversation-title" className="text-sm font-medium text-white">Connect to agent conversation</h2>
                    <p className="text-xs text-gray-400 mt-1 truncate" title={sessionName}>{sessionName}</p>
                    {list && <>
                        <p className="text-xs text-gray-400 mt-2 break-all">{list.cwd}</p>
                        <p className="text-xs text-gray-400 mt-1" data-testid="conversation-front">In front: {list.front.kind}</p>
                    </>}
                </div>
                <div className="px-4 py-3 overflow-y-auto min-h-0" aria-busy={loading}>
                    {error && <p role="alert" data-testid="conversation-error" className="text-xs text-red-300 mb-3">{error}</p>}
                    {resumeTyped && <p role="status" data-testid="conversation-resume-pending" className="text-xs text-amber-300 mb-3">Press Enter in the terminal to resume.</p>}
                    {loading && <p role="status" className="text-xs text-gray-400">Loading conversations…</p>}
                    {!loading && list && <>
                        {list.front.kind === 'claude' && <p className="text-xs text-amber-300 mb-3">Exit Claude first. Its running conversation is kept in sync automatically.</p>}
                        {list.front.kind === 'unknown' && <p className="text-xs text-amber-300 mb-3">Could not inspect the program in front. Refresh the list before connecting.</p>}
                        {unverifiedCodex && <p className="text-xs text-amber-300 mb-3">Codex is not holding a conversation file. This conversation may differ from the one on screen.</p>}
                        {(list.front.kind === 'other' || list.front.kind === 'none') && <p className="text-xs text-gray-400 mb-3">Connect saves the conversation for the next agent start.</p>}
                        {list.items.length === 0 && <p className="text-xs text-gray-400">No conversations with a first message were found in this folder.</p>}
                        <div role="radiogroup" aria-label="Agent conversations" data-testid="conversation-list" className="space-y-2">
                            {list.items.map(item => {
                                const disabled = blocked(item) || connecting
                                const runningHere = item.agent === list.front.kind && item.id === list.front.runningId
                                const current = item.agent === list.current?.agent && item.id === list.current?.id
                                return <label
                                    key={itemKey(item)}
                                    data-testid="conversation-row"
                                    data-agent={item.agent}
                                    data-conversation-id={item.id}
                                    className={`flex gap-2 rounded border p-3 ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-white/5'} ${selectedKey === itemKey(item) ? 'border-blue-500/70 bg-blue-500/10' : 'border-white/10'}`}
                                >
                                    <input
                                        type="radio"
                                        name="agent-conversation"
                                        value={itemKey(item)}
                                        checked={selectedKey === itemKey(item)}
                                        disabled={disabled}
                                        onChange={() => setSelectedKey(itemKey(item))}
                                        className="mt-0.5 accent-blue-500 shrink-0"
                                    />
                                    <div className="min-w-0 flex-1 text-xs">
                                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                            <span className="font-medium text-gray-100">{agentName(item.agent)}</span>
                                            <span className="text-gray-400">{dateLabel(item.startedAt)}</span>
                                            {runningHere ? <span className="text-emerald-300">Running here</span> : item.startedHere ? <span className="text-blue-300">Started here</span> : null}
                                            {current && <span className="text-gray-400">Connected</span>}
                                        </div>
                                        <p className="mt-1 text-gray-300 break-words">{item.firstMessage}</p>
                                        <p className="mt-1 text-gray-500">Updated {dateLabel(item.updatedAt)} · {Math.max(1, Math.round(item.bytes / 1024))} KB</p>
                                        {item.linkedTo && <p className="mt-1 text-amber-300 break-words">Linked: {item.linkedTo.name}</p>}
                                    </div>
                                </label>
                            })}
                        </div>
                        {list.truncated && <p className="text-xs text-gray-500 mt-3">Showing recent conversations only. Older conversations may not appear.</p>}
                    </>}
                </div>
                <div className="px-4 py-3 border-t border-white/10 flex flex-wrap justify-end items-center gap-2">
                    <button type="button" onClick={() => void load()} disabled={loading || connecting} className="mr-auto p-1.5 text-gray-400 hover:text-white disabled:opacity-40" title="Refresh conversations" aria-label="Refresh conversations">
                        <RefreshCw size={14} />
                    </button>
                    <button ref={cancelRef} type="button" onClick={onClose} disabled={connecting} className="px-3 py-1.5 text-xs rounded text-gray-300 hover:bg-white/10 disabled:opacity-40">{resumeTyped ? 'Close' : 'Cancel'}</button>
                    {list?.front.kind !== 'claude' && !resumeTyped && <button type="button" data-testid="conversation-connect" onClick={() => void connect()} disabled={!canConnect} className="px-3 py-1.5 text-xs rounded bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed">{buttonLabel}</button>}
                </div>
            </div>
        </div>,
        document.body
    )
}
