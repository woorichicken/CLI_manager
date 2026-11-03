import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AlertTriangle, Bot, ChevronDown, ExternalLink, Layers, ListChecks } from 'lucide-react'
import type { ConversationAgent, ConversationMeta } from '../../../../shared/conversation'
import { formatTokens, modelLabel, todoProgress, type TodoItem } from './chatLib'
import { TodoList } from './WorkBlock'

/**
 * The quiet row under the message box: the model and its reasoning effort, how full the context
 * is, the plan's progress and the pages the agent published (ovis Composer.tsx 1441~1470 · the
 * BackgroundTasks plan chip · Artifacts). Each opens a small panel above it.
 */

function Popover({ open, onClose, children, align = 'start', testId }: { open: boolean; onClose: () => void; children: ReactNode; align?: 'start' | 'end'; testId?: string }) {
    const box = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        const onDown = (event: MouseEvent): void => {
            if (box.current && !box.current.parentElement?.contains(event.target as Node)) onClose()
        }
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                onClose()
            }
        }
        window.addEventListener('mousedown', onDown, true)
        window.addEventListener('keydown', onKey, true)
        return () => {
            window.removeEventListener('mousedown', onDown, true)
            window.removeEventListener('keydown', onKey, true)
        }
    }, [open, onClose])
    if (!open) return null
    return (
        <div ref={box} className={`chat-popover is-${align}`} role="dialog" data-testid={testId}>
            {children}
        </div>
    )
}

const CLAUDE_MODELS: { alias: string; label: string; note: string }[] = [
    { alias: 'default', label: 'Default', note: 'the model your plan recommends' },
    { alias: 'opus', label: 'Opus', note: 'most capable' },
    { alias: 'sonnet', label: 'Sonnet', note: 'everyday work' },
    { alias: 'haiku', label: 'Haiku', note: 'fastest' }
]

/**
 * The model chip. ovis only shows it; here it also changes the model, because the person asked
 * for it — through the agent's own `/model`, the only way either agent offers. Claude Code saves a
 * `/model` choice as the default for new sessions too, so every change asks first.
 */
export function ModelChip({
    agent,
    meta,
    working,
    onCommand
}: {
    agent: ConversationAgent | null
    meta: ConversationMeta | null
    working: boolean
    /** sends a `/model …` the way a typed message goes */
    onCommand: (text: string) => void
}) {
    const [open, setOpen] = useState(false)
    const [confirm, setConfirm] = useState<{ text: string; label: string } | null>(null)
    const model = meta?.model ? modelLabel(meta.model) : null
    const close = (): void => {
        setOpen(false)
        setConfirm(null)
    }
    if (!agent) return null
    return (
        <span className="chat-chip-anchor">
            <button
                type="button"
                className="chat-meta-chip"
                data-testid="chat-model-chip"
                aria-haspopup="dialog"
                aria-expanded={open}
                title={`${meta?.model ?? 'Model not recorded yet'}${meta?.effort ? ` · reasoning ${meta.effort}` : ''} — change model`}
                onClick={() => (open ? close() : setOpen(true))}
            >
                <Bot size={12} aria-hidden="true" />
                <span className={model && !model.named ? 'chat-meta-id' : undefined} data-testid="chat-model-name">
                    {model?.text ?? 'Model'}
                </span>
                {meta?.effort && (
                    <span className="chat-meta-effort" data-testid="chat-model-effort">
                        · {meta.effort}
                    </span>
                )}
                <ChevronDown size={11} aria-hidden="true" />
            </button>
            <Popover open={open} onClose={close} testId="chat-model-menu">
                {confirm ? (
                    <div className="chat-confirm" data-testid="chat-model-confirm">
                        <p className="chat-confirm-title">
                            <AlertTriangle size={13} aria-hidden="true" /> Also changes the default
                        </p>
                        <p>
                            {agent === 'claude'
                                ? `Claude Code saves a /model choice as your default for new sessions (its settings.json). This session and every new Claude Code session will use ${confirm.label}.`
                                : 'Codex may save the model you pick as its default for new sessions (config.toml).'}
                        </p>
                        {working && <p className="chat-confirm-note">The agent is working: the command waits for the turn to end.</p>}
                        <div className="chat-confirm-actions">
                            <button type="button" className="chat-confirm-primary" data-testid="chat-model-confirm-ok" onClick={() => (onCommand(confirm.text), close())}>
                                {confirm.text === '/model' ? 'Open the picker' : `Use ${confirm.label}`}
                            </button>
                            <button type="button" data-testid="chat-model-confirm-cancel" onClick={() => setConfirm(null)}>
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="chat-menu-list" role="menu">
                        <div className="chat-menu-caption">
                            Now: <strong>{meta?.model ?? 'not recorded yet'}</strong>
                            {meta?.effort ? ` · reasoning ${meta.effort}` : ''}
                        </div>
                        {agent === 'claude' &&
                            CLAUDE_MODELS.map((choice) => (
                                <button
                                    key={choice.alias}
                                    type="button"
                                    role="menuitem"
                                    className="chat-menu-item"
                                    data-testid="chat-model-option"
                                    data-alias={choice.alias}
                                    onClick={() => setConfirm({ text: `/model ${choice.alias}`, label: choice.label })}
                                >
                                    <span>{choice.label}</span>
                                    <span className="chat-menu-note">{choice.note}</span>
                                </button>
                            ))}
                        <button
                            type="button"
                            role="menuitem"
                            className="chat-menu-item"
                            data-testid="chat-model-picker"
                            onClick={() => setConfirm({ text: '/model', label: 'the model you pick' })}
                        >
                            <span>{agent === 'claude' ? 'Other model or effort…' : 'Change model or effort…'}</span>
                            <span className="chat-menu-note">picker in the terminal</span>
                        </button>
                    </div>
                )}
            </Popover>
        </span>
    )
}

/** How full the context is: a share when the window is known (Codex), the tokens otherwise (Claude). */
export function ContextChip({ meta, canCompact, onCompact }: { meta: ConversationMeta | null; canCompact: boolean; onCompact: () => void }) {
    const [open, setOpen] = useState(false)
    const context = meta?.context
    if (!context) return null
    const percent = context.window ? Math.min(100, Math.round((context.used / context.window) * 100)) : null
    const label = percent !== null ? `${percent}%` : formatTokens(context.used)
    const detail = context.window
        ? `${context.used.toLocaleString()} of ${context.window.toLocaleString()} tokens`
        : `${context.used.toLocaleString()} tokens (the transcript does not record the window size)`
    return (
        <span className="chat-chip-anchor">
            <button
                type="button"
                className={`chat-meta-chip${percent !== null && percent >= 80 ? ' is-high' : ''}`}
                data-testid="chat-context-chip"
                title={`Context: ${detail}`}
                aria-expanded={open}
                onClick={() => setOpen(!open)}
            >
                {percent !== null && <Ring percent={percent} />}
                <span>ctx {label}</span>
            </button>
            <Popover open={open} onClose={() => setOpen(false)} align="end" testId="chat-context-panel">
                <div className="chat-confirm">
                    <p className="chat-confirm-title">
                        <Layers size={13} aria-hidden="true" /> Context
                    </p>
                    <p>{detail}</p>
                    <div className="chat-confirm-actions">
                        <button
                            type="button"
                            className="chat-confirm-primary"
                            data-testid="chat-compact"
                            disabled={!canCompact}
                            title={canCompact ? 'Send /compact' : 'Wait for the turn to end'}
                            onClick={() => (onCompact(), setOpen(false))}
                        >
                            Compact now
                        </button>
                    </div>
                </div>
            </Popover>
        </span>
    )
}

function Ring({ percent }: { percent: number }) {
    const radius = 5
    const length = 2 * Math.PI * radius
    return (
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="chat-ring">
            <circle cx="6" cy="6" r={radius} fill="none" strokeWidth="2" className="chat-ring-track" />
            <circle
                cx="6"
                cy="6"
                r={radius}
                fill="none"
                strokeWidth="2"
                className="chat-ring-fill"
                strokeDasharray={`${(length * percent) / 100} ${length}`}
                transform="rotate(-90 6 6)"
            />
        </svg>
    )
}

/** The plan the agent keeps (its latest TodoWrite / update_plan): progress, and the list on a click. */
export function PlanChip({ items }: { items: TodoItem[] | null }) {
    const [open, setOpen] = useState(false)
    if (!items || items.length === 0) return null
    const { done, total, current } = todoProgress(items)
    if (done === total && !open) return null
    return (
        <span className="chat-chip-anchor">
            <button
                type="button"
                className="chat-meta-chip"
                data-testid="chat-plan-chip"
                aria-expanded={open}
                title={current ? `Now: ${current.active ?? current.label}` : 'The agent’s plan'}
                onClick={() => setOpen(!open)}
            >
                <ListChecks size={12} aria-hidden="true" />
                <span>
                    {done}/{total}
                </span>
                {current && <span className="chat-meta-current">{current.active ?? current.label}</span>}
            </button>
            <Popover open={open} onClose={() => setOpen(false)} testId="chat-plan-panel">
                <div className="chat-menu-caption">
                    Plan · {done}/{total} done
                </div>
                <TodoList items={items} />
            </Popover>
        </span>
    )
}

/** Pages published with Claude's Artifact tool in the turns read. */
export function ArtifactsChip({ links, onOpen }: { links: { url: string; title: string }[]; onOpen: (url: string) => void }) {
    const [open, setOpen] = useState(false)
    if (links.length === 0) return null
    return (
        <span className="chat-chip-anchor">
            <button type="button" className="chat-meta-chip" data-testid="chat-artifacts-chip" aria-expanded={open} title="Pages this conversation published" onClick={() => setOpen(!open)}>
                <ExternalLink size={12} aria-hidden="true" />
                <span>{links.length}</span>
            </button>
            <Popover open={open} onClose={() => setOpen(false)} testId="chat-artifacts-panel">
                <div className="chat-menu-caption">Artifacts</div>
                <div className="chat-menu-list">
                    {links.map((link) => (
                        <button key={link.url} type="button" className="chat-menu-item" title={link.url} onClick={() => (onOpen(link.url), setOpen(false))}>
                            <span>{link.title}</span>
                            <ExternalLink size={11} aria-hidden="true" />
                        </button>
                    ))}
                </div>
            </Popover>
        </span>
    )
}
