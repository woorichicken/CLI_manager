import { useEffect, useRef, useState } from 'react'
import { Check, X, FolderPlus, Power, Copy, BookOpen } from 'lucide-react'
import { gettingStartedReplayedDone, stepsOf, type GettingStartedState, type GettingStartedStep } from '../../../../shared/gettingStarted'

const COPIED_NOTICE_MS = 1800

const STEP_TEXT: Record<GettingStartedStep, { title: string; hint: string }> = {
    folder: {
        title: 'Add a project folder',
        hint: 'Sidebar header › + (Add Workspace), then pick the folder you work in.'
    },
    agent: {
        title: 'Start Claude Code or Codex',
        hint: 'Click + on the folder row › Claude Code or Codex.'
    },
    chat: {
        title: 'Send your first message',
        hint: 'Type a request to the agent and press Enter — in Terminal or Chat.'
    },
    ai: {
        title: 'Connect an AI agent',
        hint: 'Let Claude Code or Codex open and drive sessions here: turn on the API, install the skill.'
    }
}

interface GettingStartedCardProps {
    state: GettingStartedState
    /** 'full' on the empty main pane; 'compact' at the sidebar's foot once a session is open */
    variant: 'full' | 'compact'
    onDismiss: () => void
    /** the folder step's button opens the same picker as the sidebar's + */
    onAddFolder?: () => void
    /** the AI step's buttons — each does the thing, it does not just describe it */
    onTurnOnControlApi?: () => void
    onCopyInstallCommand?: () => Promise<boolean> | boolean
    onOpenApiDocs?: () => void
    /** why the last «Turn on» did not start the server (port taken, …) */
    controlApiError?: string | null
    /** a start is in progress: the button waits */
    controlApiBusy?: boolean
}

const ACTION_BUTTON = 'inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-blue-200 bg-blue-500/15 hover:bg-blue-500/25'

/** The «Connect an AI agent» step: what turning the API on opens, three buttons, and the two live conditions. */
function ConnectAiActions({ state, onTurnOnControlApi, onCopyInstallCommand, onOpenApiDocs, controlApiError, controlApiBusy }: Omit<GettingStartedCardProps, 'variant' | 'onDismiss' | 'onAddFolder'>) {
    const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
    const apiOn = state.ai?.apiOn === true
    const skillFound = state.ai?.skillFound === true
    const copy = async (): Promise<void> => {
        const ok = onCopyInstallCommand ? (await onCopyInstallCommand()) !== false : false
        setCopied(ok ? 'ok' : 'failed')
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setCopied(null), COPIED_NOTICE_MS)
    }
    return (
        <div className="mt-1.5 space-y-1.5" data-getting-started-ai>
            {!apiOn && (
                <div className="text-[11px] text-gray-400 leading-snug" data-getting-started-ai-warning>
                    Turning it on starts a server on this Mac only (127.0.0.1, token-protected). An agent can then open, read and type into sessions here — including ones you opened.
                </div>
            )}
            <div className="flex flex-wrap gap-1.5">
                {apiOn ? (
                    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-green-300 bg-green-500/10" data-getting-started-ai-on>
                        <Power size={12} /> AI Control API: On
                    </span>
                ) : (
                    <button type="button" onClick={onTurnOnControlApi} disabled={controlApiBusy} className={`${ACTION_BUTTON} disabled:opacity-50`} data-getting-started-turn-on-api>
                        <Power size={12} /> Turn on AI Control API
                    </button>
                )}
                <button type="button" onClick={() => void copy()} className={ACTION_BUTTON} data-getting-started-copy-install>
                    <Copy size={12} /> {copied === 'ok' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy install command'}
                </button>
                <button type="button" onClick={onOpenApiDocs} className={ACTION_BUTTON} data-getting-started-api-docs>
                    <BookOpen size={12} /> API docs
                </button>
            </div>
            <div className="text-[10px] text-gray-500 leading-snug" data-getting-started-ai-status>
                Skill: {skillFound ? 'installed' : 'not found yet — paste the command in a terminal'}
            </div>
            {controlApiError && !apiOn && <div className="text-[10px] text-red-300 leading-snug" data-getting-started-ai-error>{controlApiError}</div>}
        </div>
    )
}

/**
 * First-run checklist (fb-1120b). Every tick comes from main, from what actually happened — the
 * card has no buttons that tick a step (the AI step's buttons turn the API on, copy and open docs;
 * its tick still waits for the result). ✕ hides it for good; Settings › General › Onboarding
 * brings it back.
 */
export function GettingStartedCard({ state, variant, onDismiss, onAddFolder, ...aiProps }: GettingStartedCardProps) {
    const steps = stepsOf(state)
    const doneCount = steps.filter((step) => state.done[step]).length
    const next = steps.find((step) => !state.done[step])
    const allDoneBefore = gettingStartedReplayedDone(state)
    const doneNote = (
        <div className="text-[11px] text-gray-300 leading-snug" data-getting-started-all-done>
            You've already done all {steps.length === 4 ? 'four' : 'three'} steps — nothing to set up again. Close this with ✕.
        </div>
    )
    const header = (
        <div className="flex items-center gap-2">
            <span className={`font-semibold text-white ${variant === 'full' ? 'text-sm' : 'text-xs'}`}>Getting started</span>
            <span className="text-[11px] text-gray-400 tabular-nums" data-getting-started-count>{doneCount}/{steps.length}</span>
            <button
                type="button"
                onClick={onDismiss}
                className="ml-auto p-0.5 rounded text-gray-500 hover:text-white hover:bg-white/10"
                title="Hide the checklist (Settings › General › Onboarding shows it again)"
                aria-label="Hide the checklist"
                data-getting-started-dismiss
            >
                <X size={variant === 'full' ? 14 : 12} />
            </button>
        </div>
    )
    const bar = (
        <div className="h-1 rounded bg-white/10 overflow-hidden">
            <div className="h-full bg-blue-400/80 transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
    )

    if (variant === 'compact') {
        return (
            <div className="mx-2 mb-2 p-2.5 rounded-lg border border-blue-500/25 bg-blue-500/10 space-y-1.5" data-getting-started="compact">
                {header}
                {bar}
                {allDoneBefore && doneNote}
                {next && (
                    <div className="text-[11px] leading-snug" data-getting-started-next={next}>
                        <div className="text-gray-200">{STEP_TEXT[next].title}</div>
                        <div className="text-gray-400">{STEP_TEXT[next].hint}</div>
                        {next === 'ai' && <ConnectAiActions state={state} {...aiProps} />}
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="w-[360px] max-w-[calc(100%-32px)] p-4 rounded-xl border border-white/10 bg-white/[0.04] space-y-3 text-left" data-getting-started="full">
            {header}
            {bar}
            {allDoneBefore && doneNote}
            <ol className="space-y-2.5">
                {steps.map((step) => {
                    const done = !!state.done[step]
                    const already = state.alreadyDone.includes(step)
                    return (
                        <li key={step} className="flex gap-2.5" data-getting-started-step={step} data-done={done ? 'true' : 'false'}>
                            <span className={`mt-0.5 w-4 h-4 shrink-0 rounded-full flex items-center justify-center border ${done ? 'bg-green-500/80 border-green-500/80 text-white' : 'border-gray-500'}`}>
                                {done && <Check size={10} strokeWidth={3} />}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2">
                                    <span className={`text-xs ${done ? 'text-gray-500 line-through' : 'text-gray-100'}`}>{STEP_TEXT[step].title}</span>
                                    {already && (
                                        <span className="text-[10px] text-green-300/80" data-getting-started-already>Already done</span>
                                    )}
                                </div>
                                {!done && <div className="text-[11px] text-gray-400 leading-snug">{STEP_TEXT[step].hint}</div>}
                                {!done && step === 'folder' && onAddFolder && (
                                    <button
                                        type="button"
                                        onClick={onAddFolder}
                                        className={`mt-1.5 ${ACTION_BUTTON}`}
                                        data-getting-started-add-folder
                                    >
                                        <FolderPlus size={12} /> Add folder…
                                    </button>
                                )}
                                {!done && step === 'ai' && <ConnectAiActions state={state} {...aiProps} />}
                            </div>
                        </li>
                    )
                })}
            </ol>
        </div>
    )
}
