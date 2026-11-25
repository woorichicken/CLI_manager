import { useEffect, useMemo, useRef, useState } from 'react'
import { X } from 'lucide-react'
import {
    MAX_TAGS_PER_SESSION,
    SESSION_WORK_ROLES,
    SESSION_WORK_ROLE_HINTS,
    SESSION_WORK_ROLE_LABELS,
    normalizeTags,
    splitTagInput,
    tagsInUse,
    type SessionWorkRole
} from '../../../../shared/sessionLabels'
import type { TerminalSession } from '../../../../shared/types'
import { SessionRoleIcon } from './SessionRoleIcon'

/** How many tags other sessions use are offered under the box. */
const SUGGESTION_COUNT = 6

interface SessionLabelsDialogProps {
    sessionName: string
    role?: SessionWorkRole
    tags: string[]
    /** Tags in use across the app, most used first — offered so a batch is not spelt two ways. */
    knownTags: string[]
    /** Resolves false when the app refused (the session is gone); the dialog stays open and says so. */
    onSave: (role: SessionWorkRole | null, tags: string[]) => Promise<boolean>
    onCancel: () => void
}

/**
 * A session's role and tags (decision 0015). Nothing is saved until Save; Esc and the backdrop
 * cancel. Enter or a comma turns the typed word into a tag; Backspace in an empty box removes the
 * last one.
 */
export function SessionLabelsDialog({ sessionName, role: initialRole, tags: initialTags, knownTags, onSave, onCancel }: SessionLabelsDialogProps) {
    const [role, setRole] = useState<SessionWorkRole | null>(initialRole ?? null)
    const [tags, setTags] = useState<string[]>(initialTags)
    const [draft, setDraft] = useState('')
    const [saving, setSaving] = useState(false)
    const [failed, setFailed] = useState(false)
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        // Capture phase: Esc must not reach the terminal behind (it would interrupt the agent).
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            e.stopPropagation()
            onCancel()
        }
        window.addEventListener('keydown', onKey, true)
        return () => window.removeEventListener('keydown', onKey, true)
    }, [onCancel])

    const full = tags.length >= MAX_TAGS_PER_SESSION
    const suggestions = useMemo(() => {
        const have = new Set(tags.map(tag => tag.toLowerCase()))
        return knownTags.filter(tag => !have.has(tag.toLowerCase())).slice(0, SUGGESTION_COUNT)
    }, [knownTags, tags])

    const addTags = (words: string[]): void => {
        if (words.length === 0) return
        setTags(prev => normalizeTags([...prev, ...words]))
    }
    const commitDraft = (): string[] => {
        const words = splitTagInput(draft)
        setDraft('')
        const next = normalizeTags([...tags, ...words])
        setTags(next)
        return next
    }

    const save = async (): Promise<void> => {
        if (saving) return
        // A word still in the box counts — Save should not drop what the person just typed.
        const finalTags = commitDraft()
        setSaving(true)
        setFailed(false)
        let ok = false
        try {
            ok = await onSave(role, finalTags)
        } catch {
            ok = false
        } finally {
            setSaving(false)
        }
        if (!ok) setFailed(true)
    }

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center px-4" role="dialog" aria-label="Role and tags" data-session-labels-dialog>
            <div className="absolute inset-0 bg-black/40 backdrop-blur-[2px]" onClick={onCancel} />
            <div className="relative w-full max-w-sm glass-panel rounded-lg shadow-2xl border border-white/10 px-4 py-3 space-y-3">
                <div className="text-sm text-white truncate" title={sessionName}>Role and tags — {sessionName}</div>

                <div className="space-y-1">
                    <div className="text-[11px] text-gray-500">Role</div>
                    <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="Role">
                        {[...SESSION_WORK_ROLES, null].map(option => {
                            const picked = role === option
                            return (
                                <button
                                    key={option ?? 'none'}
                                    role="radio"
                                    aria-checked={picked}
                                    data-labels-role={option ?? 'none'}
                                    onClick={() => setRole(option)}
                                    title={option ? SESSION_WORK_ROLE_HINTS[option] : 'No role'}
                                    className={`flex items-center gap-1.5 px-2 py-1 rounded text-xs border transition-colors ${
                                        picked ? 'border-blue-500/50 bg-blue-500/20 text-blue-100' : 'border-white/10 bg-white/5 text-gray-300 hover:bg-white/10'
                                    }`}
                                >
                                    {option && <SessionRoleIcon role={option} size={12} />}
                                    {option ? SESSION_WORK_ROLE_LABELS[option] : 'None'}
                                </button>
                            )
                        })}
                    </div>
                </div>

                <div className="space-y-1">
                    <label className="text-[11px] text-gray-500" htmlFor="session-labels-tag-input">Tags</label>
                    <div
                        className="flex flex-wrap items-center gap-1 bg-black/30 border border-white/10 rounded px-1.5 py-1 focus-within:border-blue-500/50"
                        onClick={() => inputRef.current?.focus()}
                    >
                        {tags.map(tag => (
                            <span key={tag} data-labels-tag={tag} className="flex items-center gap-0.5 pl-1.5 pr-0.5 py-0.5 rounded bg-white/10 text-xs text-gray-200">
                                {tag}
                                <button
                                    aria-label={`Remove ${tag}`}
                                    onClick={(e) => {
                                        e.stopPropagation()
                                        setTags(prev => prev.filter(t => t !== tag))
                                    }}
                                    className="p-0.5 rounded text-gray-400 hover:text-white hover:bg-white/10"
                                >
                                    <X size={10} />
                                </button>
                            </span>
                        ))}
                        <input
                            id="session-labels-tag-input"
                            ref={inputRef}
                            value={draft}
                            disabled={full}
                            onChange={e => {
                                const value = e.target.value
                                if (value.includes(',')) {
                                    const parts = value.split(',')
                                    addTags(splitTagInput(parts.slice(0, -1).join(',')))
                                    setDraft(parts[parts.length - 1])
                                } else setDraft(value)
                            }}
                            onKeyDown={e => {
                                if (e.nativeEvent.isComposing) return
                                if (e.key === 'Enter') {
                                    e.preventDefault()
                                    if (draft.trim()) commitDraft()
                                    else void save()
                                } else if (e.key === 'Backspace' && !draft && tags.length) {
                                    setTags(prev => prev.slice(0, -1))
                                }
                            }}
                            placeholder={full ? `Up to ${MAX_TAGS_PER_SESSION} tags` : tags.length ? '' : 'Add a tag…'}
                            className="flex-1 min-w-[80px] bg-transparent text-xs text-white placeholder-gray-600 outline-none py-0.5"
                            data-labels-tag-input
                            autoFocus
                        />
                    </div>
                    {suggestions.length > 0 && !full && (
                        <div className="flex flex-wrap items-center gap-1 text-[11px] text-gray-500">
                            <span>Used elsewhere:</span>
                            {suggestions.map(tag => (
                                <button
                                    key={tag}
                                    data-labels-suggestion={tag}
                                    onClick={() => addTags([tag])}
                                    className="px-1 rounded hover:bg-white/10 hover:text-gray-200"
                                >
                                    #{tag}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {failed && <span className="text-[11px] text-red-400" role="alert" data-labels-error>Could not save — the session may have closed.</span>}
                    <button
                        onClick={onCancel}
                        className="ml-auto px-2.5 py-1 rounded text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onClick={() => void save()}
                        disabled={saving}
                        className="px-3 py-1 rounded text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:bg-white/5 disabled:text-gray-500 transition-colors"
                        data-labels-save
                    >
                        Save
                    </button>
                </div>
            </div>
        </div>
    )
}

const EDIT_LABELS_EVENT = 'climanager:edit-session-labels'

/** Opens the role and tags editor for a session — from the sidebar row's menu or a tab's menu. */
export function requestEditSessionLabels(sessionId: string): void {
    window.dispatchEvent(new CustomEvent(EDIT_LABELS_EVENT, { detail: sessionId }))
}

interface SessionLabelsHostProps {
    sessions: TerminalSession[]
    onSave: (sessionId: string, change: { role: SessionWorkRole | null; tags: string[] }) => Promise<boolean>
}

/** Mounted once (in the sidebar); shows the editor for whichever menu asked. */
export function SessionLabelsHost({ sessions, onSave }: SessionLabelsHostProps) {
    const [sessionId, setSessionId] = useState<string | null>(null)
    useEffect(() => {
        const onRequest = (e: Event): void => setSessionId((e as CustomEvent<string>).detail)
        window.addEventListener(EDIT_LABELS_EVENT, onRequest)
        return () => window.removeEventListener(EDIT_LABELS_EVENT, onRequest)
    }, [])
    const knownTags = useMemo(() => tagsInUse(sessions), [sessions])
    const session = sessionId ? sessions.find(s => s.id === sessionId) : undefined
    // Closed underneath the editor: nothing left to label.
    useEffect(() => {
        if (sessionId && !session) setSessionId(null)
    }, [sessionId, session])
    if (!session) return null
    return (
        <SessionLabelsDialog
            key={session.id}
            sessionName={session.name}
            role={session.role}
            tags={session.tags ?? []}
            knownTags={knownTags}
            onCancel={() => setSessionId(null)}
            onSave={async (role, tags) => {
                const ok = await onSave(session.id, { role, tags })
                if (ok) setSessionId(null)
                return ok
            }}
        />
    )
}
