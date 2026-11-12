import { BrowserWindow, ipcMain, powerMonitor } from 'electron'
import os from 'os'
import { join } from 'path'
import type { ConversationService } from '../ConversationService'
import { saveChatAttachment } from '../chatAttachments'
import { maskSecretLines, type MaskOptions } from '../maskSecrets'
import { SessionScreenStatusPoller } from '../SessionScreenStatus'
import type { TerminalEventLog } from '../TerminalEventLog'
import type { TerminalManager } from '../TerminalManager'
import type { TerminalMirror } from '../TerminalMirror'
import type { PhoneSession, PhoneSessionsResponse, PhoneSessionState, PhoneUsageResponse } from '../../shared/phone'
import type { AgentStatusUpdate, AppConfig, PhoneSettings, PhoneState, SessionFolder, UsageSnapshot, UserSettings, Workspace, WorkspaceFolder } from '../../shared/types'
import { DEFAULT_PHONE } from '../../shared/types'
import { DEFAULT_QUICK_REPLIES } from '../../shared/conversation'
// The sidebar's own ordering functions (pure, types only): the phone's list is the Mac's All
// sessions List exactly because it is computed by the same code, not a copy of it.
import { groupBySessionFolder, orderForAllSessions, sessionsInSidebarOrder, type SessionEntry } from '../../renderer/src/utils/sessionNavigation'
import { workspacesInLoadOrder } from '../workspaceLoadOrder'
import { PhoneDevices } from './PhoneDevices'
import { dockHostFiles, dockLocation, PhoneDock } from './phoneDock'
import { PhonePush } from './PhonePush'
import { PhoneServer } from './PhoneServer'
import { TailscaleStatus } from './tailscaleStatus'
import { phoneQueueHooks } from './phoneQueue'
import { AgentSwapReader, appUsageForPhone, runAgentSwapInLoginShell, type AgentSwapRun } from './phoneUsage'
import type { PhoneFeedbackDeps } from './phoneFeedback'

/**
 * Builds the phone connection out of main's existing parts and registers its IPC
 * (Settings › Phone, the sidebar badge). Everything it needs already runs in main —
 * sessions, mirrors, ConversationService — this only opens a second door to them.
 */

export const PHONE_STATE_CHANNEL = 'phone-state-changed'
/** a person who has not touched the Mac this long is not "at the Mac" */
const AT_MAC_IDLE_SECONDS = 120

export interface PhoneSetupDeps {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    store: { get(key: keyof AppConfig): any; set(key: 'settings', value: UserSettings): void }
    terminals: TerminalManager
    mirror: TerminalMirror
    eventLog: TerminalEventLog
    conversation: ConversationService
    /** the app's own usage reading (UsageTracker); absent, the usage view shows agent-swap's only */
    usageSnapshot?(): UsageSnapshot
    /** `aswap list --json`; tests hand a fake. Absent: the user's login shell */
    agentSwapRun?: AgentSwapRun
    hookStatus(id: string): AgentStatusUpdate | null
    broadcast(channel: string, payload: unknown): void
    mask: MaskOptions
    userDataDir: string
    /** out/renderer */
    staticDir: string
    /** recently viewed session ids, newest first (RecentSessions) — the All sessions order */
    recentSessions(): string[]
    /** the ids in the order the sidebar draws sessions, as the renderer last reported it (null before it has) */
    sidebarSessionOrder(): string[] | null
    /** the feedback widget on the phone page: main's relay and terminal context (phoneFeedback.ts) */
    feedback?: PhoneFeedbackDeps
}

export interface PhoneSetup {
    server: PhoneServer
    /** apply the saved setting at startup */
    start(): Promise<void>
    /** a session was deleted */
    forgetSession(sessionId: string): void
}

export function setupPhone(deps: PhoneSetupDeps): PhoneSetup {
    const dir = join(deps.userDataDir, 'phone')
    const devices = new PhoneDevices(join(dir, 'devices.json'))
    const tailscale = new TailscaleStatus()

    const workspaces = (): Workspace[] => (deps.store.get('workspaces') as Workspace[] | undefined) ?? []
    const findSession = (id: string): { name: string; agent: boolean } | null => {
        for (const workspace of workspaces()) {
            const session = workspace.sessions?.find((s) => s.id === id)
            if (session) return { name: session.name, agent: session.cliToolName === 'claude' || session.cliToolName === 'codex' }
        }
        return null
    }
    const maskLine = (text: string): string => maskSecretLines([text], deps.mask).lines[0] ?? ''

    const push = new PhonePush({
        keysFile: join(dir, 'vapid.json'),
        subscriptionsFile: join(dir, 'push.json'),
        macInUse: () => {
            const override = process.env.CLIMANGER_TEST_USERDATA ? (globalThis as { __phoneMacInUse?: boolean }).__phoneMacInUse : undefined
            if (override !== undefined) return override
            const front = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.isVisible() && !w.isMinimized() && w.isFocused())
            return front && powerMonitor.getSystemIdleTime() < AT_MAC_IDLE_SECONDS
        },
        session: findSession
    })

    // A status poller of the phone's own: alerts and the list's dots, while the server runs —
    // the sidebar's poller follows its own setting (off by default).
    let server: PhoneServer
    const poller = new SessionScreenStatusPoller({
        mirror: deps.mirror,
        hookStatus: deps.hookStatus,
        publish: (message) => {
            if (message.changes.length > 0) server.statusChanged(message.changes)
        }
    })

    const listSessions = (): PhoneSessionsResponse => {
        const dots = new Map(poller.snapshot().changes.map((c) => [c.sessionId, c]))
        const settings = deps.store.get('settings') as UserSettings | undefined
        const folders = (deps.store.get('folders') as WorkspaceFolder[] | undefined) ?? []
        const sessionFolders = (deps.store.get('sessionFolders') as SessionFolder[] | undefined) ?? []
        // The sidebar's All sessions (List), top to bottom, by the sidebar's own steps: the order it
        // draws sessions in (sessionsInSidebarOrder) → pinned first, then recently viewed
        // (orderForAllSessions) → session folders first (groupBySessionFolder).
        const all = workspaces()
        const loadOrder = sessionsInSidebarOrder(workspacesInLoadOrder([...all]), folders, settings?.showWorktrees ?? true, settings?.showPlayground ?? true)
        const reported = deps.sidebarSessionOrder()
        let drawn: SessionEntry[] = loadOrder
        if (reported) {
            // The renderer's order wins (a workspace drag lives only there). Names, pins and folders are
            // read fresh from the store; a session it has not reported yet follows in load order.
            const byId = new Map(all.flatMap((workspace) => (workspace.sessions ?? []).map((session) => [session.id, { workspace, session }] as const)))
            const listed = reported.map((id) => byId.get(id)).filter((entry): entry is SessionEntry => entry !== undefined)
            const seen = new Set(listed.map((entry) => entry.session.id))
            drawn = [...listed, ...loadOrder.filter((entry) => !seen.has(entry.session.id))]
        }
        const entries = orderForAllSessions(drawn, deps.recentSessions())
        const grouped = groupBySessionFolder(entries, sessionFolders)
        const ordered = [...grouped.folders.flatMap((group) => group.rows), ...grouped.unfiled]
        const sessions = ordered.map(({ workspace, session }): PhoneSession => {
            const dot = dots.get(session.id)
            let state: PhoneSessionState = 'idle'
            if (!deps.terminals.hasTerminal(session.id)) state = 'stopped'
            else if (deps.mirror.hasExited(session.id)) state = 'exited'
            else if (dot?.state === 'waiting') state = 'waiting'
            else if (dot?.state === 'working') state = 'working'
            const agent = session.cliToolName === 'claude' ? 'claude' : session.cliToolName === 'codex' ? 'codex' : null
            const folderId = session.sessionFolderId && sessionFolders.some((f) => f.id === session.sessionFolderId) ? session.sessionFolderId : undefined
            return {
                id: session.id,
                name: session.name,
                workspaceId: workspace.id,
                workspaceName: workspace.name,
                agent,
                state,
                ...(state === 'waiting' && dot?.question ? { question: maskLine(dot.question) } : {}),
                ...(folderId ? { sessionFolderId: folderId } : {}),
                ...(session.isPinned ? { pinned: true } : {})
            }
        })
        return {
            sessions,
            sessionFolders: grouped.folders.filter((group) => group.rows.length > 0).map(({ folder }) => ({ id: folder.id, name: folder.name }))
        }
    }
    const sessionExists = (id: string): boolean => findSession(id) !== null
    // agent-swap is asked only while a phone looks at the usage view (3b4efdfc)
    const agentSwap = new AgentSwapReader(deps.agentSwapRun ?? runAgentSwapInLoginShell())
    const usage = async (): Promise<PhoneUsageResponse> => ({
        app: appUsageForPhone(deps.usageSnapshot?.() ?? {}),
        agentSwap: await agentSwap.read()
    })

    const broadcastState = (): void => deps.broadcast(PHONE_STATE_CHANNEL, server.state())
    let stateTimer: NodeJS.Timeout | null = null
    // a burst of changes (a page loading its chunks) is one message
    const onStateChange = (): void => {
        if (stateTimer) return
        stateTimer = setTimeout(() => {
            stateTimer = null
            broadcastState()
        }, 100)
    }

    // Tests count refused resize messages from main.
    const testCounters = process.env.CLIMANGER_TEST_USERDATA ? ((globalThis as { __phoneResizeRefused?: number }).__phoneResizeRefused = 0, true) : false

    const dock = new PhoneDock({
        ...dockLocation(process.env, process.platform, os.homedir()),
        hostFiles: dockHostFiles(os.homedir()),
        sessionName: (id) => findSession(id)?.name ?? null,
        maskLine
    })

    const queueHooks = phoneQueueHooks(deps.conversation)
    server = new PhoneServer({
        devices,
        push,
        tailscale,
        staticDir: deps.staticDir,
        onStateChange,
        statusPoller: poller,
        listSessions,
        sessionExists,
        usage,
        dock,
        conversation: deps.conversation,
        saveAttachment: (name, bytes) => saveChatAttachment(join(os.tmpdir(), 'climanager-chat'), name, bytes),
        maskLine,
        recordPhoneInput: (sessionId, detail) => deps.eventLog.record(sessionId, 'phone-input', detail),
        terminals: deps.terminals,
        files: {
            home: os.homedir(),
            // the paired devices and the app's settings live here, whatever the folder is called
            protectedPlaces: [deps.userDataDir],
            maskLines: (lines) => maskSecretLines(lines, { ...deps.mask, joinLines: false }),
            record: (sessionId, detail) => deps.eventLog.record(sessionId, 'phone-file', detail)
        },
        ...(deps.feedback ? { feedback: deps.feedback } : {}),
        quickReplies: () => {
            const chat = (deps.store.get('settings') as UserSettings | undefined)?.chat
            return (chat?.quickReplies ?? DEFAULT_QUICK_REPLIES).filter((reply) => reply.trim())
        },
        quickRepliesSet: () => ((deps.store.get('settings') as UserSettings | undefined)?.chat?.quickReplies ?? []).some((reply) => reply.trim()),
        pinLastMessage: () => (deps.store.get('settings') as UserSettings | undefined)?.chat?.pinLastMessage === true,
        // what a disconnected device left in a Chat queue is not typed later (F03)
        onDeviceRevoked: (deviceId) => {
            queueHooks.deviceRevoked(deviceId)
        },
        subscribeConversation: (sessionId, onChange) => {
            deps.conversation.subscribe(sessionId)
            const off = phoneConversationListeners.add(sessionId, onChange)
            return () => {
                off()
                deps.conversation.unsubscribe(sessionId)
            }
        },
        ...(testCounters
            ? {
                onResizeRefused: () => {
                    const g = globalThis as { __phoneResizeRefused?: number }
                    g.__phoneResizeRefused = (g.__phoneResizeRefused ?? 0) + 1
                }
            }
            : {})
    })

    const settings = (): PhoneSettings => {
        const saved = deps.store.get('settings') as UserSettings | undefined
        return { ...DEFAULT_PHONE, ...(saved?.phone ?? {}) }
    }

    ipcMain.handle('phone-get-state', (): Promise<PhoneState> => server.refresh())
    ipcMain.handle('phone-set-enabled', async (_e, enabled: unknown): Promise<PhoneState> => {
        const saved = (deps.store.get('settings') as UserSettings | undefined) ?? ({} as UserSettings)
        const next: PhoneSettings = { ...settings(), enabled: enabled === true }
        deps.store.set('settings', { ...saved, phone: next })
        const state = await server.apply(next)
        // turned off: nothing a phone queued is typed after it (F03)
        if (!next.enabled) queueHooks.phoneOff()
        return state
    })
    ipcMain.handle('phone-start-pairing', (_e, role: unknown): PhoneState => {
        devices.startPairing(role === 'watch' ? 'watch' : 'drive')
        return server.state()
    })
    ipcMain.handle('phone-cancel-pairing', (): PhoneState => {
        devices.cancelPairing()
        return server.state()
    })
    // a revoke the disk did not take changes nothing (PhoneDevices.revoke): say so in Settings
    const revoking = (action: () => void): PhoneState => {
        try {
            action()
            return server.state()
        } catch (error) {
            return { ...server.state(), error: `Not disconnected — ${error instanceof Error ? error.message : String(error)}` }
        }
    }
    ipcMain.handle('phone-revoke-device', (_e, id: unknown): PhoneState =>
        revoking(() => {
            if (typeof id === 'string') devices.revoke(id)
        })
    )
    ipcMain.handle('phone-revoke-all', (): PhoneState => revoking(() => devices.revokeAll()))
    ipcMain.handle('phone-test-push', () => push.test())

    return {
        server,
        async start() {
            const state = await server.apply(settings())
            if (state.error) console.error('[phone]', state.error)
        },
        forgetSession(sessionId) {
            push.forgetSession(sessionId)
        }
    }
}

/**
 * Phone chat sockets listening for one session's changes. ConversationService reports
 * changes once (`onChange`); main fans them out to the windows and to these.
 */
class ConversationListeners {
    private readonly listeners = new Map<string, Set<(revision: number) => void>>()

    add(sessionId: string, listener: (revision: number) => void): () => void {
        let set = this.listeners.get(sessionId)
        if (!set) {
            set = new Set()
            this.listeners.set(sessionId, set)
        }
        set.add(listener)
        return () => {
            set!.delete(listener)
            if (set!.size === 0) this.listeners.delete(sessionId)
        }
    }

    emit(sessionId: string, revision: number): void {
        for (const listener of this.listeners.get(sessionId) ?? []) listener(revision)
    }
}

export const phoneConversationListeners = new ConversationListeners()
