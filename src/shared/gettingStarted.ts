/**
 * First-run "Getting started" checklist and the two built-in agent templates (fb-1120b tutorial).
 *
 * The checklist has three steps, each ticked by what actually happened in the app — never by a
 * click on the card: a project folder exists, an agent (Claude Code or Codex) is running in a
 * session, and that agent's conversation has a first message. Once a step is seen it stays
 * ticked (latched), so closing the session or removing the folder does not untick it.
 *
 * The state is created only when the welcome screen's Continue is pressed (first run, or the
 * Settings › General "Onboarding" replay). Existing users who never pass the welcome screen again
 * never see the card.
 */
import type { TerminalTemplate, Workspace } from './types'

export type GettingStartedStep = 'folder' | 'agent' | 'chat'

export const GETTING_STARTED_STEPS: readonly GettingStartedStep[] = ['folder', 'agent', 'chat']

export interface GettingStartedState {
    /** when the welcome screen was last accepted (ms) */
    startedAt: number
    /** the person closed the card with ✕ */
    dismissed: boolean
    /** steps seen done at least once */
    done: Partial<Record<GettingStartedStep, true>>
    /**
     * Steps already done when the welcome screen was last accepted — a replay (Settings › General ›
     * Show Again) marks them «Already done» instead of asking for them again. Empty on a first run.
     */
    alreadyDone: GettingStartedStep[]
}

export type AgentCli = 'claude' | 'codex'

/** 'unknown' until checked, or when the check itself failed — never drawn as missing. */
export type AgentCliStatus = 'installed' | 'missing' | 'unknown'

export type AgentCliStatuses = Record<AgentCli, AgentCliStatus>

/**
 * The two rows the folder's "+" menu always offers above Plain Terminal. They are not stored in
 * `customTemplates`: they never appear in Settings › Templates, never shift the ⌘T number keys,
 * and a fresh install has them without seeding anything.
 */
export const BUILTIN_AGENT_TEMPLATES: readonly (TerminalTemplate & { agent: AgentCli })[] = [
    {
        id: 'builtin-claude-code',
        name: 'Claude Code',
        icon: 'claude',
        description: 'Start Claude Code in this folder',
        command: 'claude',
        agent: 'claude'
    },
    {
        id: 'builtin-codex',
        name: 'Codex',
        icon: 'codex',
        description: 'Start Codex in this folder',
        command: 'codex',
        agent: 'codex'
    }
]

/** The program a template command starts, when it is plainly `claude …` or `codex …`. */
export function agentOfCommand(command: string | undefined): AgentCli | null {
    const first = (command ?? '').trim().split(/\s+/)[0] ?? ''
    const name = first.split('/').pop() ?? ''
    return name === 'claude' || name === 'codex' ? name : null
}

/**
 * Built-in rows to show: one is left out when the person already has their own template that
 * starts the same program (`claude --model …`), so the menu does not list Claude twice.
 * An alias template (`cldy`) is not recognised here and leaves both rows in.
 */
export function builtinTemplatesFor(custom: readonly TerminalTemplate[]): (TerminalTemplate & { agent: AgentCli })[] {
    const covered = new Set(custom.map((template) => agentOfCommand(template.command)).filter(Boolean))
    return BUILTIN_AGENT_TEMPLATES.filter((template) => !covered.has(template.agent))
}

/** A folder the person added themselves: not Home, Playground, a worktree child or one the Control API registered. */
export function isProjectFolder(workspace: Pick<Workspace, 'isHome' | 'isPlayground' | 'parentWorkspaceId' | 'aiRegistration'>): boolean {
    return !workspace.isHome && !workspace.isPlayground && !workspace.parentWorkspaceId && !workspace.aiRegistration
}

/** A fresh state for an accepted welcome screen; a replay keeps the steps already done and says so. */
export function beginGettingStarted(previous: GettingStartedState | null | undefined, now: number): GettingStartedState {
    const done = { ...(previous?.done ?? {}) }
    return { startedAt: now, dismissed: false, done, alreadyDone: GETTING_STARTED_STEPS.filter((step) => done[step]) }
}

/** Steps newly seen are added; a step once done stays done. Returns the same object when nothing changed. */
export function latchGettingStarted(state: GettingStartedState, seen: Partial<Record<GettingStartedStep, boolean>>): GettingStartedState {
    const added = GETTING_STARTED_STEPS.filter((step) => seen[step] && !state.done[step])
    if (added.length === 0) return state
    const done = { ...state.done }
    for (const step of added) done[step] = true
    return { ...state, done }
}

export function gettingStartedComplete(state: GettingStartedState): boolean {
    return GETTING_STARTED_STEPS.every((step) => state.done[step])
}

/** A replay that found every step already done: the card stays as an «all done» note until ✕. */
export function gettingStartedReplayedDone(state: GettingStartedState): boolean {
    return state.alreadyDone.length === GETTING_STARTED_STEPS.length
}

/**
 * The card is drawn while a state exists and the person has not closed it, and a step is left —
 * or the replay began with everything done (finishing the last step in this run still hides it).
 */
export function gettingStartedVisible(state: GettingStartedState | null | undefined): state is GettingStartedState {
    return !!state && !state.dismissed && (!gettingStartedComplete(state) || gettingStartedReplayedDone(state))
}

/** Reads a stored value defensively: anything not shaped like a state is no state. */
export function readGettingStartedState(value: unknown): GettingStartedState | null {
    if (!value || typeof value !== 'object') return null
    const raw = value as Record<string, unknown>
    if (typeof raw.startedAt !== 'number' || !Number.isFinite(raw.startedAt)) return null
    const done: Partial<Record<GettingStartedStep, true>> = {}
    const rawDone = raw.done && typeof raw.done === 'object' ? raw.done as Record<string, unknown> : {}
    for (const step of GETTING_STARTED_STEPS) if (rawDone[step] === true) done[step] = true
    const rawAlready = Array.isArray(raw.alreadyDone) ? raw.alreadyDone : []
    const alreadyDone = GETTING_STARTED_STEPS.filter((step) => rawAlready.includes(step) && done[step])
    return { startedAt: raw.startedAt, dismissed: raw.dismissed === true, done, alreadyDone }
}
