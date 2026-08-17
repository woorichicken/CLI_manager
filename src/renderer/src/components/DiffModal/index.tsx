import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FileDiff as FileDiffIcon, FilePlus, FileMinus, ArrowRightLeft, X, RefreshCw, Send, GitCompare } from 'lucide-react'
import { DiffBase, DiffFileSummary, DiffLine, DiffSummary, FileDiff, TerminalSession, Workspace } from '../../../../shared/types'
import { MENU_Z_INDEX } from '../../constants/styles'
import { buildReviewPrompt } from '../../utils/reviewPrompt'

interface DiffModalProps {
    workspace: Workspace
    /** Sessions in this workspace; one of them receives review comments. */
    sessions: TerminalSession[]
    /** Session to target first — normally the tab the user was just looking at. */
    activeSessionId?: string
    onClose: () => void
}

const STATUS_ICON: Record<DiffFileSummary['status'], React.ReactNode> = {
    modified: <FileDiffIcon size={12} className="text-amber-400" />,
    added: <FilePlus size={12} className="text-green-400" />,
    deleted: <FileMinus size={12} className="text-red-400" />,
    renamed: <ArrowRightLeft size={12} className="text-blue-400" />
}

/** Splits a path so the filename stays legible when the directory is long. */
function splitPath(path: string): { dir: string; name: string } {
    const index = path.lastIndexOf('/')
    return index === -1 ? { dir: '', name: path } : { dir: path.slice(0, index), name: path.slice(index + 1) }
}

/**
 * Review modal for everything an agent changed.
 *
 * The reading order is deliberately file-list-first: an agent touches ten to
 * thirty files per turn, so "what did it touch" has to be answerable before
 * "what exactly changed".
 *
 * Selecting lines and sending a comment is the reason this is a review tool
 * rather than a viewer — it puts the file path and line number into the prompt
 * so the agent does not have to be told where to look.
 */
export function DiffModal({ workspace, sessions, activeSessionId, onClose }: DiffModalProps) {
    // A worktree is compared against the branch it forked from; a plain
    // workspace has no such base, so it starts on uncommitted changes.
    const [base, setBase] = useState<DiffBase>(workspace.baseBranch ? 'base-branch' : 'head')
    const [summary, setSummary] = useState<DiffSummary | null>(null)
    const [selectedPath, setSelectedPath] = useState<string | null>(null)
    const [fileDiff, setFileDiff] = useState<FileDiff | null>(null)
    const [loading, setLoading] = useState(false)
    const [diffLoading, setDiffLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    // Selection is keyed by "hunkIndex:lineIndex" so identical content on
    // different lines never collapses into one entry.
    const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
    const lastClickedRef = useRef<{ hunk: number; line: number } | null>(null)

    const [comment, setComment] = useState('')
    const [targetSessionId, setTargetSessionId] = useState<string | undefined>(activeSessionId ?? sessions[0]?.id)
    const [sending, setSending] = useState(false)

    const loadSummary = useCallback(async () => {
        setLoading(true)
        setError(null)
        try {
            const result = await window.api.getDiffSummary(workspace.id, base)
            if (!result.success || !result.data) {
                setError(result.error ?? 'Failed to load changes')
                setSummary(null)
                return
            }
            setSummary(result.data)

            // Keep the current file selected across a refresh when it still has
            // changes; otherwise fall back to the first file.
            setSelectedPath((current) => {
                if (current && result.data!.files.some((f) => f.path === current)) return current
                return result.data!.files[0]?.path ?? null
            })
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [workspace.id, base])

    useEffect(() => {
        void loadSummary()
    }, [loadSummary])

    // Load the selected file's diff. Stale responses are discarded so rapid
    // file switching cannot render the wrong content.
    useEffect(() => {
        if (!selectedPath) {
            setFileDiff(null)
            return
        }

        let cancelled = false
        setDiffLoading(true)
        setSelectedKeys(new Set())
        lastClickedRef.current = null

        void window.api
            .getFileDiff(workspace.id, selectedPath, base)
            .then((result) => {
                if (cancelled) return
                setFileDiff(result.success && result.data ? result.data : null)
                if (!result.success) setError(result.error ?? null)
            })
            .finally(() => {
                if (!cancelled) setDiffLoading(false)
            })

        return () => {
            cancelled = true
        }
    }, [selectedPath, workspace.id, base])

    // Escape closes the modal, but not while the user is mid-sentence in the
    // comment box — losing a typed comment to a stray keypress is worse than
    // requiring one extra click.
    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return
            const target = event.target as HTMLElement | null
            if (target?.tagName === 'TEXTAREA' && comment.length > 0) return
            event.stopPropagation()
            onClose()
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
    }, [onClose, comment])

    const selectedLines = useMemo<DiffLine[]>(() => {
        if (!fileDiff) return []
        const lines: DiffLine[] = []
        fileDiff.hunks.forEach((hunk, hunkIndex) => {
            hunk.lines.forEach((line, lineIndex) => {
                if (selectedKeys.has(`${hunkIndex}:${lineIndex}`)) lines.push(line)
            })
        })
        return lines
    }, [fileDiff, selectedKeys])

    const toggleLine = (hunkIndex: number, lineIndex: number, shiftKey: boolean) => {
        const key = `${hunkIndex}:${lineIndex}`

        // Shift-click extends within a hunk — ranges that span hunks would
        // include lines the reviewer never saw between them.
        if (shiftKey && lastClickedRef.current && lastClickedRef.current.hunk === hunkIndex) {
            const from = Math.min(lastClickedRef.current.line, lineIndex)
            const to = Math.max(lastClickedRef.current.line, lineIndex)
            const next = new Set(selectedKeys)
            for (let i = from; i <= to; i++) next.add(`${hunkIndex}:${i}`)
            setSelectedKeys(next)
            return
        }

        const next = new Set(selectedKeys)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        setSelectedKeys(next)
        lastClickedRef.current = { hunk: hunkIndex, line: lineIndex }
    }

    const canSend = comment.trim().length > 0 && !!targetSessionId && !sending

    const handleSend = async () => {
        if (!canSend || !targetSessionId || !selectedPath) return
        setSending(true)
        try {
            const prompt = buildReviewPrompt(selectedPath, selectedLines, comment.trim())
            const result = await window.api.sendTextToTerminal(targetSessionId, prompt)
            if (!result.success) {
                setError(result.error ?? 'Failed to send to terminal')
                return
            }
            // Hand the user straight back to the agent so they can watch it react.
            onClose()
        } finally {
            setSending(false)
        }
    }

    const fileCount = summary?.files.length ?? 0

    return createPortal(
        <div
            className="fixed inset-0 flex items-center justify-center bg-black/60 backdrop-blur-sm"
            style={{ zIndex: MENU_Z_INDEX }}
            onClick={onClose}
        >
            <div
                className="bg-[#1e1e20] border border-white/10 rounded-lg shadow-2xl flex flex-col"
                style={{ width: '92vw', height: '88vh', maxWidth: '1600px' }}
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center gap-3 px-4 py-2.5 border-b border-white/10 shrink-0">
                    <GitCompare size={15} className="text-gray-400" />
                    <span className="text-sm font-medium text-white">Diff</span>
                    <span className="text-xs text-gray-500 truncate">{summary?.baseLabel ?? workspace.name}</span>

                    <div className="flex-1" />

                    {fileCount > 0 && (
                        <span className="text-xs text-gray-400">
                            {fileCount} file{fileCount === 1 ? '' : 's'}
                            <span className="text-green-400 ml-2">+{summary?.totalAdditions ?? 0}</span>
                            <span className="text-red-400 ml-1.5">−{summary?.totalDeletions ?? 0}</span>
                        </span>
                    )}

                    {/* The base toggle only makes sense when a fork point exists. */}
                    {workspace.baseBranch && (
                        <div className="flex text-xs rounded overflow-hidden border border-white/10">
                            <button
                                onClick={() => setBase('base-branch')}
                                className={`px-2 py-1 transition-colors ${base === 'base-branch' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-white/5'}`}
                                title={`All changes since branching from ${workspace.baseBranch}`}
                            >
                                vs {workspace.baseBranch}
                            </button>
                            <button
                                onClick={() => setBase('head')}
                                className={`px-2 py-1 transition-colors ${base === 'head' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-white/5'}`}
                                title="Uncommitted changes only"
                            >
                                Uncommitted
                            </button>
                        </div>
                    )}

                    <button
                        onClick={() => void loadSummary()}
                        className="p-1.5 hover:bg-white/10 rounded transition-colors"
                        title="Refresh"
                    >
                        <RefreshCw size={14} className={`text-gray-400 ${loading ? 'animate-spin' : ''}`} />
                    </button>
                    <button onClick={onClose} className="p-1.5 hover:bg-white/10 rounded transition-colors" title="Close (Esc)">
                        <X size={14} className="text-gray-400" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 flex min-h-0">
                    {/* File list */}
                    <div className="w-64 shrink-0 border-r border-white/10 overflow-y-auto">
                        {loading && fileCount === 0 && <div className="p-3 text-xs text-gray-500">Loading changes…</div>}
                        {!loading && fileCount === 0 && !error && (
                            <div className="p-3 text-xs text-gray-500">No changes to review.</div>
                        )}
                        {summary?.files.map((file) => {
                            const { dir, name } = splitPath(file.path)
                            const active = file.path === selectedPath
                            return (
                                <button
                                    key={file.path}
                                    onClick={() => setSelectedPath(file.path)}
                                    className={`w-full text-left px-2.5 py-1.5 flex items-start gap-2 transition-colors ${active ? 'bg-blue-600/20 border-l-2 border-blue-500' : 'border-l-2 border-transparent hover:bg-white/5'}`}
                                >
                                    <span className="mt-0.5 shrink-0">{STATUS_ICON[file.status]}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-xs text-white truncate" title={file.path}>
                                            {name}
                                        </span>
                                        {dir && <span className="block text-[10px] text-gray-500 truncate">{dir}</span>}
                                    </span>
                                    {!file.binary && (
                                        <span className="text-[10px] shrink-0 mt-0.5">
                                            <span className="text-green-400">+{file.additions}</span>{' '}
                                            <span className="text-red-400">−{file.deletions}</span>
                                        </span>
                                    )}
                                </button>
                            )
                        })}
                    </div>

                    {/* Diff pane */}
                    <div className="flex-1 min-w-0 flex flex-col">
                        <div className="flex-1 overflow-auto font-mono text-xs">
                            {error && <div className="p-3 text-xs text-red-400">{error}</div>}
                            {diffLoading && <div className="p-3 text-gray-500">Loading diff…</div>}

                            {!diffLoading && fileDiff?.binary && (
                                <div className="p-3 text-gray-500">Binary file — no textual diff.</div>
                            )}

                            {!diffLoading &&
                                fileDiff?.hunks.map((hunk, hunkIndex) => (
                                    <div key={hunkIndex}>
                                        <div className="px-3 py-1 bg-white/5 text-[11px] text-gray-500 sticky top-0">
                                            {hunk.header}
                                        </div>
                                        {hunk.lines.map((line, lineIndex) => {
                                            const key = `${hunkIndex}:${lineIndex}`
                                            const selected = selectedKeys.has(key)
                                            const background = selected
                                                ? 'bg-blue-500/25'
                                                : line.type === 'add'
                                                  ? 'bg-green-500/10'
                                                  : line.type === 'del'
                                                    ? 'bg-red-500/10'
                                                    : ''
                                            const text =
                                                line.type === 'add'
                                                    ? 'text-green-300'
                                                    : line.type === 'del'
                                                      ? 'text-red-300'
                                                      : 'text-gray-300'
                                            return (
                                                <div
                                                    key={key}
                                                    onClick={(e) => toggleLine(hunkIndex, lineIndex, e.shiftKey)}
                                                    className={`flex cursor-pointer hover:bg-white/5 ${background}`}
                                                >
                                                    <span className="w-12 shrink-0 text-right pr-2 text-gray-600 select-none">
                                                        {line.oldNumber ?? ''}
                                                    </span>
                                                    <span className="w-12 shrink-0 text-right pr-2 text-gray-600 select-none">
                                                        {line.newNumber ?? ''}
                                                    </span>
                                                    <span className="w-4 shrink-0 text-center select-none text-gray-500">
                                                        {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ''}
                                                    </span>
                                                    <span className={`whitespace-pre flex-1 pr-3 ${text}`}>{line.content || ' '}</span>
                                                </div>
                                            )
                                        })}
                                    </div>
                                ))}

                            {fileDiff?.truncated && (
                                <div className="p-3 text-[11px] text-amber-400">
                                    Diff truncated — this file changed too much to display in full.
                                </div>
                            )}
                        </div>

                        {/* Review bar */}
                        <div className="border-t border-white/10 p-2.5 shrink-0">
                            <div className="flex items-center gap-2 mb-1.5">
                                <span className="text-[11px] text-gray-500">
                                    {selectedLines.length > 0
                                        ? `${selectedLines.length} line${selectedLines.length === 1 ? '' : 's'} selected`
                                        : 'Click lines to cite them (shift-click for a range)'}
                                </span>
                                <div className="flex-1" />
                                {sessions.length > 0 && (
                                    <select
                                        value={targetSessionId}
                                        onChange={(e) => setTargetSessionId(e.target.value)}
                                        className="bg-black/30 border border-white/10 rounded px-1.5 py-1 text-[11px] text-gray-300 focus:outline-none focus:border-blue-500"
                                        title="Which agent receives this comment"
                                    >
                                        {sessions.map((session) => (
                                            <option key={session.id} value={session.id}>
                                                {session.name}
                                            </option>
                                        ))}
                                    </select>
                                )}
                            </div>
                            <div className="flex gap-2">
                                <textarea
                                    value={comment}
                                    onChange={(e) => setComment(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                                            e.preventDefault()
                                            void handleSend()
                                        }
                                    }}
                                    rows={2}
                                    placeholder={
                                        selectedPath
                                            ? 'What should the agent change here?  (⌘↵ to send)'
                                            : 'Select a file first'
                                    }
                                    disabled={!selectedPath}
                                    className="flex-1 bg-black/30 border border-white/10 rounded px-2 py-1.5 text-xs text-white resize-none focus:outline-none focus:border-blue-500 disabled:opacity-50"
                                />
                                <button
                                    onClick={() => void handleSend()}
                                    disabled={!canSend}
                                    className="px-3 self-stretch bg-blue-600 text-white rounded text-xs hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
                                    title="Send to the selected agent's terminal (⌘↵)"
                                >
                                    <Send size={13} />
                                    Send
                                </button>
                            </div>
                            {sessions.length === 0 && (
                                <p className="text-[11px] text-amber-400 mt-1.5">
                                    This workspace has no terminal session to send feedback to.
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>,
        document.body
    )
}
