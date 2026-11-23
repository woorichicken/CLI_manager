import { Check, X, FolderPlus } from 'lucide-react'
import { GETTING_STARTED_STEPS, type GettingStartedState, type GettingStartedStep } from '../../../../shared/gettingStarted'

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
    }
}

interface GettingStartedCardProps {
    state: GettingStartedState
    /** 'full' on the empty main pane; 'compact' at the sidebar's foot once a session is open */
    variant: 'full' | 'compact'
    onDismiss: () => void
    /** the folder step's button opens the same picker as the sidebar's + */
    onAddFolder?: () => void
}

/**
 * First-run checklist (fb-1120b). Every tick comes from main, from what actually happened — the
 * card has no buttons that tick a step. ✕ hides it for good; Settings › General › Onboarding
 * brings it back.
 */
export function GettingStartedCard({ state, variant, onDismiss, onAddFolder }: GettingStartedCardProps) {
    const doneCount = GETTING_STARTED_STEPS.filter((step) => state.done[step]).length
    const next = GETTING_STARTED_STEPS.find((step) => !state.done[step])
    const header = (
        <div className="flex items-center gap-2">
            <span className={`font-semibold text-white ${variant === 'full' ? 'text-sm' : 'text-xs'}`}>Getting started</span>
            <span className="text-[11px] text-gray-400 tabular-nums" data-getting-started-count>{doneCount}/{GETTING_STARTED_STEPS.length}</span>
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
            <div className="h-full bg-blue-400/80 transition-all" style={{ width: `${(doneCount / GETTING_STARTED_STEPS.length) * 100}%` }} />
        </div>
    )

    if (variant === 'compact') {
        return (
            <div className="mx-2 mb-2 p-2.5 rounded-lg border border-blue-500/25 bg-blue-500/10 space-y-1.5" data-getting-started="compact">
                {header}
                {bar}
                {next && (
                    <div className="text-[11px] leading-snug" data-getting-started-next={next}>
                        <div className="text-gray-200">{STEP_TEXT[next].title}</div>
                        <div className="text-gray-400">{STEP_TEXT[next].hint}</div>
                    </div>
                )}
            </div>
        )
    }

    return (
        <div className="w-[360px] max-w-[calc(100%-32px)] p-4 rounded-xl border border-white/10 bg-white/[0.04] space-y-3 text-left" data-getting-started="full">
            {header}
            {bar}
            <ol className="space-y-2.5">
                {GETTING_STARTED_STEPS.map((step) => {
                    const done = !!state.done[step]
                    return (
                        <li key={step} className="flex gap-2.5" data-getting-started-step={step} data-done={done ? 'true' : 'false'}>
                            <span className={`mt-0.5 w-4 h-4 shrink-0 rounded-full flex items-center justify-center border ${done ? 'bg-green-500/80 border-green-500/80 text-white' : 'border-gray-500'}`}>
                                {done && <Check size={10} strokeWidth={3} />}
                            </span>
                            <div className="min-w-0 flex-1">
                                <div className={`text-xs ${done ? 'text-gray-500 line-through' : 'text-gray-100'}`}>{STEP_TEXT[step].title}</div>
                                {!done && <div className="text-[11px] text-gray-400 leading-snug">{STEP_TEXT[step].hint}</div>}
                                {!done && step === 'folder' && onAddFolder && (
                                    <button
                                        type="button"
                                        onClick={onAddFolder}
                                        className="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-blue-200 bg-blue-500/15 hover:bg-blue-500/25"
                                        data-getting-started-add-folder
                                    >
                                        <FolderPlus size={12} /> Add folder…
                                    </button>
                                )}
                            </div>
                        </li>
                    )
                })}
            </ol>
        </div>
    )
}
