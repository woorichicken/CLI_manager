import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { CalendarClock, Play, Pause, Plus, Trash2, Pencil, ExternalLink, FolderOpen } from 'lucide-react'
import type { CronInput, CronRun, CronState, CronView } from '../../../../shared/autocron'
import { DEFAULT_MISSED, MissedPolicy, nextRun, parseCron } from '../../../../shared/cron'
import type { LoopProject } from '../../../../shared/types'

/**
 * Loop window › Autocron: jobs CLI Manager starts on a schedule — open a new agent session,
 * or type into a promoted /loop. Same jobs as the Control API `/v1/crons`.
 */

const LIST_WIDTH = 280

const PRESETS: Array<{ label: string; schedule: string }> = [
    { label: 'Every day 08:00', schedule: '0 8 * * *' },
    { label: 'Weekdays 09:00', schedule: '0 9 * * 1-5' },
    { label: 'Every hour', schedule: '0 * * * *' },
    { label: 'Every 30 minutes', schedule: '*/30 * * * *' },
    { label: 'Mondays 10:00', schedule: '0 10 * * 1' }
]

const MISSED_LABELS: Record<MissedPolicy, string> = {
    once: 'Run once when back',
    skip: 'Skip to the next time',
    notify: 'Do not run — notify me'
}

function useCrons() {
    const [state, setState] = useState<CronState>({ crons: [], runs: [] })
    useEffect(() => {
        let cancelled = false
        window.api.listCrons().then((r) => {
            if (!cancelled && r.success && r.data) setState(r.data)
        }).catch(() => {})
        const off = window.api.onCronState((s) => setState(s))
        return () => {
            cancelled = true
            off()
        }
    }, [])
    return state
}

function formatWhen(ms: number | null | undefined): string {
    if (!ms) return '—'
    const d = new Date(ms)
    const sameDay = d.toDateString() === new Date().toDateString()
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    return sameDay ? `Today ${time}` : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

/** The grey line beside a run: how it was triggered, what was folded in, and the note — joined with « · ». */
function runDetail(run: CronRun): string {
    return [
        run.trigger === 'manual' ? 'manual' : run.trigger === 'caught-up' ? `late, ran at ${formatWhen(run.at)}` : '',
        run.missedCount > 0 ? `${run.missedCount} earlier folded in` : '',
        run.note ?? ''
    ].filter(Boolean).join(' · ')
}

function RunStatus({ run }: { run: CronRun | null }) {
    if (!run) return <span className="text-gray-600">never ran</span>
    const color = run.status === 'started' ? 'text-green-400' : run.status === 'missed' ? 'text-amber-400' : 'text-red-400'
    const label = run.status === 'started' ? (run.trigger === 'caught-up' ? 'caught up' : 'ran') : run.status
    return <span className={color}>{label}</span>
}

// -------------------------------------------------------
// Edit form
// -------------------------------------------------------

interface FormProps {
    initial?: CronView
    loopProjects: LoopProject[]
    onCancel: () => void
    onSaved: (cron: CronView) => void
}

function CronForm({ initial, loopProjects, onCancel, onSaved }: FormProps) {
    const [name, setName] = useState(initial?.name ?? '')
    const [mode, setMode] = useState(initial?.mode ?? 'new')
    const [agentKind, setAgentKind] = useState<'command' | 'template'>(initial?.template ? 'template' : 'command')
    const [agent, setAgent] = useState(initial?.agent ?? 'claude')
    const [template, setTemplate] = useState(initial?.template ?? '')
    const [cwd, setCwd] = useState(initial?.cwd ?? '')
    const [loopProjectId, setLoopProjectId] = useState(initial?.loopProjectId ?? loopProjects[0]?.id ?? '')
    const [prompt, setPrompt] = useState(initial?.prompt ?? '')
    const [schedule, setSchedule] = useState(initial?.schedule ?? '0 8 * * *')
    const [policy, setPolicy] = useState<MissedPolicy>(initial?.missed.policy ?? DEFAULT_MISSED.policy)
    const [withinHours, setWithinHours] = useState(String((initial?.missed.withinMinutes ?? DEFAULT_MISSED.withinMinutes) / 60))
    const [error, setError] = useState<string | null>(null)
    const [saving, setSaving] = useState(false)

    const preview = useMemo(() => {
        const parsed = parseCron(schedule)
        if (!parsed.ok) return { ok: false, text: parsed.message }
        return { ok: true, text: `Next: ${formatWhen(nextRun(parsed.schedule, Date.now()))}` }
    }, [schedule])

    const save = async () => {
        setSaving(true)
        setError(null)
        const input: CronInput = {
            name,
            mode,
            schedule,
            prompt,
            missed: { policy, withinMinutes: Math.round(Number(withinHours) * 60) },
            ...(mode === 'new'
                ? { cwd, ...(agentKind === 'template' ? { template, agent: '' } : { agent, template: '' }) }
                : { loopProjectId })
        }
        const result = initial ? await window.api.updateCron(initial.id, input) : await window.api.createCron(input)
        setSaving(false)
        if (result.success && result.data) onSaved(result.data)
        else setError(result.error ?? 'Could not save')
    }

    const label = 'block text-[11px] uppercase tracking-wide text-gray-500 mb-1'
    const box = 'bg-white/5 border border-white/10 rounded px-2 py-1.5 text-sm text-gray-200 focus:outline-none focus:border-purple-400/60'
    const field = `w-full ${box}`

    return (
        <div className="flex-1 overflow-y-auto p-5" data-testid="autocron-form">
            <h2 className="text-sm font-semibold text-gray-200 mb-4">{initial ? 'Edit job' : 'New job'}</h2>
            <div className="grid gap-4 max-w-xl">
                <div>
                    <span className={label}>Name</span>
                    <input className={field} value={name} onChange={(e) => setName(e.target.value)} placeholder="Morning plan" data-testid="autocron-name" />
                </div>

                <div>
                    <span className={label}>What runs</span>
                    <div className="flex gap-2">
                        {(['new', 'attach'] as const).map((m) => (
                            <button
                                key={m}
                                type="button"
                                onClick={() => setMode(m)}
                                className={`px-3 py-1.5 rounded text-xs border ${mode === m ? 'border-purple-400/70 bg-purple-500/15 text-purple-200' : 'border-white/10 text-gray-400 hover:text-gray-200'}`}
                                data-testid={`autocron-mode-${m}`}
                            >
                                {m === 'new' ? 'New session each time' : 'Type into a loop'}
                            </button>
                        ))}
                    </div>
                </div>

                {mode === 'new' ? (
                    <>
                        <div>
                            <span className={label}>Agent</span>
                            <div className="flex gap-2">
                                <select className={`${box} w-36 shrink-0`} value={agentKind} onChange={(e) => setAgentKind(e.target.value as 'command' | 'template')}>
                                    <option value="command">Command</option>
                                    <option value="template">Template</option>
                                </select>
                                {agentKind === 'command' ? (
                                    <input className={field} value={agent} onChange={(e) => setAgent(e.target.value)} placeholder="claude" list="autocron-agents" data-testid="autocron-agent" />
                                ) : (
                                    <input className={field} value={template} onChange={(e) => setTemplate(e.target.value)} placeholder="Template name" />
                                )}
                                <datalist id="autocron-agents">
                                    <option value="claude" />
                                    <option value="codex" />
                                </datalist>
                            </div>
                        </div>
                        <div>
                            <span className={label}>Folder</span>
                            <div className="flex gap-2">
                                <input className={field} value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/project" data-testid="autocron-cwd" />
                                <button
                                    type="button"
                                    className="px-2 rounded border border-white/10 text-gray-400 hover:text-gray-200"
                                    title="Choose folder"
                                    onClick={async () => {
                                        const dir = await window.api.selectDirectory()
                                        if (dir) setCwd(dir)
                                    }}
                                >
                                    <FolderOpen size={14} />
                                </button>
                            </div>
                        </div>
                    </>
                ) : (
                    <div>
                        <span className={label}>Loop</span>
                        {loopProjects.length === 0 ? (
                            <p className="text-xs text-gray-500">No loop projects yet — promote a workspace to Loop first.</p>
                        ) : (
                            <select className={field} value={loopProjectId} onChange={(e) => setLoopProjectId(e.target.value)} data-testid="autocron-loop">
                                {loopProjects.map((p) => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                        )}
                    </div>
                )}

                <div>
                    <span className={label}>Prompt</span>
                    <textarea className={`${field} h-24 font-mono`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="/content-plan work next" data-testid="autocron-prompt" />
                </div>

                <div>
                    <span className={label}>When</span>
                    <div className="flex gap-2">
                        <select className={`${box} w-44 shrink-0`} value={PRESETS.find((p) => p.schedule === schedule)?.schedule ?? ''} onChange={(e) => e.target.value && setSchedule(e.target.value)}>
                            <option value="">Custom</option>
                            {PRESETS.map((p) => (
                                <option key={p.schedule} value={p.schedule}>{p.label}</option>
                            ))}
                        </select>
                        <input className={`${field} font-mono`} value={schedule} onChange={(e) => setSchedule(e.target.value)} data-testid="autocron-schedule" />
                    </div>
                    <p className={`text-xs mt-1 ${preview.ok ? 'text-gray-500' : 'text-red-400'}`} data-testid="autocron-schedule-preview">{preview.text}</p>
                </div>

                <div>
                    <span className={label}>If it could not run on time (Mac off, asleep, app closed)</span>
                    <div className="flex gap-2 items-center">
                        <select className={field} value={policy} onChange={(e) => setPolicy(e.target.value as MissedPolicy)} data-testid="autocron-missed">
                            {(Object.keys(MISSED_LABELS) as MissedPolicy[]).map((p) => (
                                <option key={p} value={p}>{MISSED_LABELS[p]}</option>
                            ))}
                        </select>
                        {policy === 'once' && (
                            <>
                                <span className="text-xs text-gray-500 whitespace-nowrap">if within</span>
                                <input className={`${box} w-16 shrink-0`} type="number" min={1} max={168} value={withinHours} onChange={(e) => setWithinHours(e.target.value)} />
                                <span className="text-xs text-gray-500">h</span>
                            </>
                        )}
                    </div>
                </div>

                {error && <p className="text-xs text-red-400" data-testid="autocron-error">{error}</p>}
                <div className="flex gap-2">
                    <button type="button" disabled={saving} onClick={save} className="px-3 py-1.5 rounded bg-purple-500/80 hover:bg-purple-500 text-xs text-white disabled:opacity-50" data-testid="autocron-save">
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button type="button" onClick={onCancel} className="px-3 py-1.5 rounded border border-white/10 text-xs text-gray-400 hover:text-gray-200">Cancel</button>
                </div>
            </div>
        </div>
    )
}

// -------------------------------------------------------
// Detail: one job and its runs
// -------------------------------------------------------

function CronDetail({ cron, runs, onEdit }: { cron: CronView; runs: CronRun[]; onEdit: () => void }) {
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState<string | null>(null)

    const runNow = async () => {
        setBusy(true)
        setMessage(null)
        const r = await window.api.runCron(cron.id)
        setBusy(false)
        if (!r.success) setMessage(r.error ?? 'Could not run')
    }
    const toggle = () => window.api.updateCron(cron.id, { enabled: !cron.enabled })
    const remove = async () => {
        if (window.confirm(`Delete "${cron.name}" and its run history?`)) await window.api.removeCron(cron.id)
    }
    const open = async (sessionId: string) => {
        const r = await window.api.openCronSession(sessionId)
        if (!r.success || !r.data) setMessage('That session is closed.')
    }

    const what = cron.mode === 'new' ? `New ${cron.template ? `"${cron.template}"` : cron.agent} session in ${cron.cwd}` : 'Types into a loop'
    const btn = 'flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/10 text-xs text-gray-300 hover:text-white hover:border-white/25 disabled:opacity-50'

    return (
        <div className="flex-1 overflow-y-auto p-5" data-testid="autocron-detail">
            <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                    <h2 className="text-base font-semibold text-gray-100 truncate">{cron.name}</h2>
                    <p className="text-xs text-gray-500 mt-0.5 truncate">{what}</p>
                </div>
                <div className="flex gap-2 shrink-0">
                    <button className={btn} disabled={busy} onClick={runNow} data-testid="autocron-run-now"><Play size={12} /> Run now</button>
                    <button className={btn} onClick={toggle} data-testid="autocron-toggle">{cron.enabled ? <><Pause size={12} /> Pause</> : <><Play size={12} /> Resume</>}</button>
                    <button className={btn} onClick={onEdit}><Pencil size={12} /> Edit</button>
                    <button className={btn} onClick={remove} title="Delete"><Trash2 size={12} /></button>
                </div>
            </div>

            {cron.problem && <p className="mt-3 text-xs text-red-400">{cron.problem}</p>}
            {message && <p className="mt-3 text-xs text-amber-400">{message}</p>}

            <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 mt-4 text-xs">
                <dt className="text-gray-500">Schedule</dt><dd className="text-gray-300 font-mono">{cron.schedule}</dd>
                <dt className="text-gray-500">Next run</dt><dd className="text-gray-300" data-testid="autocron-next">{cron.enabled ? formatWhen(cron.nextRunAt) : 'paused'}</dd>
                <dt className="text-gray-500">If missed</dt><dd className="text-gray-300">{MISSED_LABELS[cron.missed.policy]}{cron.missed.policy === 'once' ? ` (within ${cron.missed.withinMinutes / 60} h)` : ''}</dd>
                <dt className="text-gray-500">Prompt</dt><dd className="text-gray-300 font-mono whitespace-pre-wrap break-words">{cron.prompt}</dd>
            </dl>

            <h3 className="mt-6 mb-2 text-[11px] uppercase tracking-wide text-gray-500">Runs</h3>
            {runs.length === 0 ? (
                <p className="text-xs text-gray-600">No runs yet.</p>
            ) : (
                <table className="w-full text-xs" data-testid="autocron-runs">
                    <tbody>
                        {runs.map((run) => (
                            <tr key={run.id} className="border-t border-white/5">
                                <td className="py-1.5 pr-3 text-gray-400 whitespace-nowrap">{formatWhen(run.plannedAt)}</td>
                                <td className="py-1.5 pr-3 whitespace-nowrap"><RunStatus run={run} /></td>
                                <td className="py-1.5 pr-3 text-gray-500">{runDetail(run)}</td>
                                <td className="py-1.5 text-right">
                                    {run.sessionId && (
                                        <button className="inline-flex items-center gap-1 text-purple-300 hover:text-purple-200" onClick={() => open(run.sessionId!)} data-testid="autocron-open-session">
                                            <ExternalLink size={11} /> Open session
                                        </button>
                                    )}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    )
}

// -------------------------------------------------------
// Panel
// -------------------------------------------------------

export function AutocronPanel({ loopProjects }: { loopProjects: LoopProject[] }) {
    const { crons, runs } = useCrons()
    const [selectedId, setSelectedId] = useState<string | null>(null)
    const [editing, setEditing] = useState<'new' | string | null>(null)

    useEffect(() => {
        if (selectedId && !crons.some((c) => c.id === selectedId)) setSelectedId(null)
        if (!selectedId && crons.length > 0 && editing === null) setSelectedId(crons[0].id)
    }, [crons, selectedId, editing])

    const selected = crons.find((c) => c.id === selectedId) ?? null
    const runsFor = useCallback((id: string) => runs.filter((r) => r.cronId === id), [runs])

    return (
        <div className="flex flex-1 min-h-0" data-testid="autocron-panel">
            <div className="flex flex-col border-r border-white/10 bg-black/30 shrink-0 overflow-hidden" style={{ width: LIST_WIDTH }}>
                <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
                    <span className="text-[11px] uppercase tracking-wide text-gray-500">Jobs</span>
                    <button className="flex items-center gap-1 text-xs text-purple-300 hover:text-purple-200" onClick={() => setEditing('new')} data-testid="autocron-new">
                        <Plus size={12} /> New
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {crons.length === 0 && <p className="px-3 py-4 text-xs text-gray-600">No jobs yet.</p>}
                    {crons.map((c) => (
                        <button
                            key={c.id}
                            onClick={() => {
                                setSelectedId(c.id)
                                setEditing(null)
                            }}
                            className={`w-full text-left px-3 py-2 border-b border-white/5 ${c.id === selectedId && editing === null ? 'bg-white/5' : 'hover:bg-white/[0.03]'}`}
                            data-testid="autocron-item"
                        >
                            <div className="flex items-center gap-2">
                                <CalendarClock size={12} className={c.enabled ? 'text-purple-400' : 'text-gray-600'} />
                                <span className={`text-sm truncate ${c.enabled ? 'text-gray-200' : 'text-gray-500'}`}>{c.name}</span>
                            </div>
                            <div className="flex justify-between text-[11px] mt-0.5 pl-5">
                                <span className="text-gray-500">{c.enabled ? `next ${formatWhen(c.nextRunAt)}` : 'paused'}</span>
                                <RunStatus run={c.lastRun} />
                            </div>
                        </button>
                    ))}
                </div>
            </div>

            {editing !== null ? (
                <CronForm
                    key={editing}
                    initial={editing === 'new' ? undefined : crons.find((c) => c.id === editing)}
                    loopProjects={loopProjects}
                    onCancel={() => setEditing(null)}
                    onSaved={(cron) => {
                        setEditing(null)
                        setSelectedId(cron.id)
                    }}
                />
            ) : selected ? (
                <CronDetail cron={selected} runs={runsFor(selected.id)} onEdit={() => setEditing(selected.id)} />
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-center px-6">
                    <CalendarClock size={36} className="text-purple-400/40" />
                    <p className="text-sm text-gray-400">Run an agent on a schedule</p>
                    <p className="text-xs text-gray-600 max-w-xs">Open a new Claude or Codex session with a prompt, or type into a loop — every day, every hour, on weekdays.</p>
                    <button className="mt-2 px-3 py-1.5 rounded bg-purple-500/80 hover:bg-purple-500 text-xs text-white" onClick={() => setEditing('new')}>New job</button>
                </div>
            )}
        </div>
    )
}
