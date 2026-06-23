import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Infinity as InfinityIcon } from 'lucide-react'
import { LoopProject, LoopSession } from '../../../../shared/types'
import { formatRelativeTime, formatClock, formatDuration, intervalStats } from '../../utils/loopTime'

interface LoopStatsModalProps {
    project: LoopProject
    session: LoopSession | undefined
    onClose: () => void
}

const STATUS_META: Record<string, { label: string; dot: string; text: string }> = {
    running: { label: 'Running', dot: 'bg-green-500', text: 'text-green-400' },
    ready: { label: 'Ready', dot: 'bg-amber-500/80', text: 'text-amber-300' },
    stopped: { label: 'Stopped', dot: 'border-2 border-red-500', text: 'text-red-400' },
}

export function LoopStatsModal({ project, session, onClose }: LoopStatsModalProps) {
    const [preview, setPreview] = useState<string[] | null>(null)

    // Close on Escape.
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') onClose()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    // Fetch the last terminal output lines (reuses the existing preview buffer).
    useEffect(() => {
        let cancelled = false
        if (session?.terminalId && typeof window.api.getTerminalPreview === 'function') {
            window.api
                .getTerminalPreview(session.terminalId, 10)
                .then((lines: string[]) => {
                    if (!cancelled) setPreview(lines)
                })
                .catch(() => {
                    if (!cancelled) setPreview([])
                })
        } else {
            setPreview([])
        }
        return () => {
            cancelled = true
        }
    }, [session?.terminalId])

    const status = session?.status ?? 'stopped'
    const meta = STATUS_META[status] ?? STATUS_META.stopped
    const { avg, min, max } = intervalStats(session?.recentLoops)

    // Recent loops, newest first for display.
    const timeline = [...(session?.recentLoops ?? [])].reverse()

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
            onClick={onClose}
        >
            <motion.div
                initial={{ opacity: 0, scale: 0.97 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.12 }}
                className="w-full max-w-md max-h-full overflow-hidden flex flex-col rounded-xl border border-white/10 bg-[#16161a] shadow-2xl"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center gap-2 px-4 py-3 border-b border-white/10 shrink-0">
                    <InfinityIcon size={14} className="text-purple-400 shrink-0" />
                    <span className="text-sm font-semibold text-white truncate">{project.name}</span>
                    <span className={`ml-1 inline-flex items-center gap-1.5 text-xs ${meta.text}`}>
                        <span className={`inline-block w-2 h-2 rounded-full ${meta.dot}`} />
                        {meta.label}
                    </span>
                    <button
                        onClick={onClose}
                        className="ml-auto p-1 rounded text-gray-500 hover:text-white hover:bg-white/10 transition-colors"
                        title="Close (Esc)"
                    >
                        <X size={14} />
                    </button>
                </div>

                <div className="overflow-y-auto px-4 py-3 space-y-4">
                    <p className="text-xs text-gray-500 font-mono truncate" title={project.path}>
                        {project.path}
                    </p>

                    {/* Stat grid */}
                    <div className="grid grid-cols-2 gap-3">
                        <Stat label="Total loops" value={`#${session?.loopCount ?? 0}`} />
                        <Stat
                            label="Status for"
                            value={session?.statusSince ? formatDuration(Date.now() - session.statusSince) : '—'}
                        />
                        <Stat
                            label="Last loop"
                            value={formatRelativeTime(session?.lastLoopAt ?? null)}
                            sub={session?.lastLoopAt ? formatClock(session.lastLoopAt) : undefined}
                        />
                        <Stat
                            label="Started"
                            value={session ? formatRelativeTime(session.startedAt) : '—'}
                            sub={session ? formatClock(session.startedAt) : undefined}
                        />
                        <Stat label="Avg interval" value={avg !== null ? formatDuration(avg) : '—'} />
                        <Stat
                            label="Min / Max"
                            value={
                                min !== null && max !== null
                                    ? `${formatDuration(min)} / ${formatDuration(max)}`
                                    : '—'
                            }
                        />
                    </div>

                    {/* Timeline */}
                    <div>
                        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                            Recent loops
                        </h4>
                        {timeline.length === 0 ? (
                            <p className="text-xs text-gray-600">No iterations recorded yet.</p>
                        ) : (
                            <div className="max-h-44 overflow-y-auto rounded border border-white/5 divide-y divide-white/5">
                                {timeline.map((ev, i) => {
                                    // delta from the previous (older) iteration
                                    const olderAt = timeline[i + 1]?.at
                                    const delta = olderAt !== undefined ? ev.at - olderAt : null
                                    return (
                                        <div
                                            key={`${ev.index}-${ev.at}`}
                                            className="flex items-center gap-3 px-3 py-1.5 text-xs"
                                        >
                                            <span className="text-gray-500 font-mono w-10 shrink-0">#{ev.index}</span>
                                            <span className="text-gray-300 font-mono">{formatClock(ev.at)}</span>
                                            <span className="ml-auto text-gray-600 font-mono">
                                                {delta !== null ? `+${formatDuration(delta)}` : ''}
                                            </span>
                                        </div>
                                    )
                                })}
                            </div>
                        )}
                    </div>

                    {/* Last output preview */}
                    <div>
                        <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">
                            Last output
                        </h4>
                        <pre className="text-[11px] leading-relaxed text-gray-400 font-mono bg-black/40 rounded p-2 max-h-32 overflow-auto whitespace-pre-wrap break-all">
                            {preview === null
                                ? 'Loading…'
                                : preview.length === 0
                                  ? '(no output captured)'
                                  : preview.join('\n')}
                        </pre>
                    </div>
                </div>
            </motion.div>
        </div>
    )
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
    return (
        <div className="rounded-lg bg-white/5 px-3 py-2">
            <div className="text-[11px] text-gray-500">{label}</div>
            <div className="text-sm text-white font-medium truncate" title={value}>
                {value}
            </div>
            {sub && <div className="text-[11px] text-gray-600 font-mono">{sub}</div>}
        </div>
    )
}
