import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ListOrdered, RefreshCw } from 'lucide-react'
import { StatusCommandResult, StatusSource, StatusState } from '../../../shared/types'

interface StatusPanelSectionProps {
    /** Bumped by the popover's refresh button so both halves reload together. */
    refreshKey: number
    /** Tells the popover whether a status command is set, so it can widen for the rows. */
    onConfiguredChange: (configured: boolean) => void
}

const STATE_DOT: Record<StatusState, string> = {
    ok: 'bg-gray-500',
    busy: 'bg-blue-400',
    attention: 'bg-amber-400',
    blocked: 'bg-red-500',
    error: 'bg-fuchsia-400'
}
const STATE_LABEL: Record<StatusState, string> = {
    ok: 'OK',
    busy: 'Running',
    attention: 'Check',
    blocked: 'Blocked',
    error: 'Lookup failed'
}
const STATE_TEXT: Record<StatusState, string> = {
    ok: 'text-gray-500',
    busy: 'text-blue-300',
    attention: 'text-amber-300',
    blocked: 'text-red-400',
    error: 'text-fuchsia-300'
}
/** Rows that start open: the ones a person has to act on. */
const OPEN_BY_DEFAULT: readonly StatusState[] = ['blocked', 'error']

/**
 * Status panel — the queues and locks reported by Settings › General › Status command, shown under
 * the System Monitor. Fetched when the popover opens (and on refresh), never in the background.
 * The panel itself only reads. Each row says whether it is read only or can be managed — through the
 * Control API (`POST /v1/queues/…`) when Settings has an action command (decision 0014).
 */
export function StatusPanelSection({ refreshKey, onConfiguredChange }: StatusPanelSectionProps) {
    const [result, setResult] = useState<StatusCommandResult | null>(null)
    const [loading, setLoading] = useState(true)
    const [open, setOpen] = useState<Record<string, boolean>>({})

    useEffect(() => {
        let cancelled = false
        setLoading(true)
        window.api.getStatusReport()
            .then(next => {
                if (cancelled) return
                setResult(next)
                onConfiguredChange(next.configured)
            })
            .catch(err => {
                if (!cancelled) setResult({ configured: true, ok: false, error: String(err?.message ?? err), durationMs: 0 })
            })
            .finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true }
    }, [refreshKey, onConfiguredChange])

    // Nothing until the first answer: with no command set, the section must not flash on every open.
    if (!result || !result.configured) return null

    const actionsEnabled = result.ok && result.actionsEnabled
    const manageable = (source: StatusSource): boolean => actionsEnabled && source.actions.length > 0
    const actionLabel = (source: StatusSource, id: string): string => source.actions.find(a => a.id === id)?.label ?? id
    const isOpen = (source: StatusSource): boolean => open[source.id] ?? OPEN_BY_DEFAULT.includes(source.state)
    const toggle = (source: StatusSource) => setOpen(prev => ({ ...prev, [source.id]: !isOpen(source) }))

    return (
        <div className="border-t border-white/10 px-3 py-2 space-y-1.5" data-status-panel>
            <div className="flex items-center gap-2 text-xs">
                <ListOrdered size={13} className="text-gray-500 flex-shrink-0" />
                <span className="text-gray-400">Queues</span>
                {result?.configured && result.ok && (
                    <span className="ml-auto flex items-center gap-2 font-medium" data-status-counts>
                        <span className={result.report.counts.blocked > 0 ? 'text-red-400' : 'text-gray-500'}>{result.report.counts.blocked} blocked</span>
                        <span className="text-gray-600">·</span>
                        <span className={result.report.counts.attention > 0 ? 'text-amber-300' : 'text-gray-500'}>{result.report.counts.attention} check</span>
                        {result.report.counts.error > 0 && (
                            <>
                                <span className="text-gray-600">·</span>
                                <span className="text-fuchsia-300">{result.report.counts.error} failed</span>
                            </>
                        )}
                    </span>
                )}
                {loading && <RefreshCw size={11} className="text-gray-500 animate-spin ml-auto" />}
            </div>

            {result?.configured && !result.ok && (
                <div className="text-[11px] text-fuchsia-300 break-words" data-status-error>
                    Status command failed: {result.error}
                </div>
            )}

            {result?.configured && result.ok && (
                <div className="max-h-[300px] overflow-y-auto space-y-0.5 -mx-1">
                    {result.report.sources.map(source => (
                        <div key={source.id} data-status-source={source.id} data-status-state={source.state}>
                            <button
                                onClick={() => toggle(source)}
                                disabled={source.items.length === 0}
                                className="w-full flex items-start gap-1.5 px-1 py-0.5 rounded text-left text-[11px] hover:bg-white/5 disabled:hover:bg-transparent disabled:cursor-default"
                                title={[source.what, source.see && `More: ${source.see}`].filter(Boolean).join('\n')}
                            >
                                <span className="w-3 flex-shrink-0 pt-[3px] text-gray-600">
                                    {source.items.length > 0 && (isOpen(source) ? <ChevronDown size={10} /> : <ChevronRight size={10} />)}
                                </span>
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 mt-[5px] ${STATE_DOT[source.state]}`} />
                                <span className="text-gray-300 flex-shrink-0">{source.name}</span>
                                <span className={`flex-shrink-0 ${STATE_TEXT[source.state]}`}>{STATE_LABEL[source.state]}</span>
                                <span
                                    className={`flex-shrink-0 px-1 rounded text-[9px] leading-[14px] border ${manageable(source) ? 'border-emerald-500/40 text-emerald-300' : 'border-white/10 text-gray-500'}`}
                                    data-status-mode={manageable(source) ? 'manage' : 'read'}
                                    title={manageable(source)
                                        ? `Can ${source.actions.map(a => a.label).join(', ')} through the Control API`
                                        : source.actions.length > 0 ? 'Read only — set an action command in Settings › General to manage' : 'Read only'}
                                >
                                    {manageable(source) ? `Manage · ${source.actions.map(a => a.label).join(', ')}` : 'Read only'}
                                </span>
                                <span className="text-gray-500 min-w-0 truncate ml-auto" data-status-summary>{source.summary}</span>
                            </button>
                            {isOpen(source) && source.items.length > 0 && (
                                <ul className="pl-7 pr-1 pb-1 space-y-0.5">
                                    {source.items.map((item, i) => (
                                        <li key={i} className="flex items-start gap-1.5 text-[10px] text-gray-400 break-words" data-status-item>
                                            <span className={`w-1 h-1 rounded-full flex-shrink-0 mt-[5px] ${STATE_DOT[item.state ?? source.state]}`} />
                                            <span className="min-w-0">{item.text}</span>
                                            {manageable(source) && item.actions.length > 0 && (
                                                <span className="flex-shrink-0 ml-auto text-[9px] text-emerald-300/80" data-status-item-actions={item.actions.join(' ')}>
                                                    {item.actions.map(a => actionLabel(source, a)).join(' · ')}
                                                </span>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
