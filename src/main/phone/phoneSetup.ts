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
import type { PhoneSessionsResponse, PhoneSessionState } from '../../shared/phone'
import type { AgentStatusUpdate, AppConfig, PhoneSettings, PhoneState, SessionFolder, UserSettings, Workspace, WorkspaceFolder } from '../../shared/types'
import { DEFAULT_PHONE } from '../../shared/types'
import { PhoneDevices } from './PhoneDevices'
import { PhonePush } from './PhonePush'
import { PhoneServer } from './PhoneServer'
import { TailscaleStatus } from './tailscaleStatus'

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
    hookStatus(id: string): AgentStatusUpdate | null
    broadcast(channel: string, payload: unknown): void
    mask: MaskOptions
    userDataDir: string
    /** out/renderer */
    staticDir: string
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
        const home = os.homedir()
        const list = workspaces()
        const sessions = list.flatMap((workspace) =>
            (workspace.sessions ?? []).map((session) => {
                const dot = dots.get(session.id)
                let state: PhoneSessionState = 'idle'
                if (!deps.terminals.hasTerminal(session.id)) state = 'stopped'
                else if (deps.mirror.hasExited(session.id)) state = 'exited'
                else if (dot?.state === 'waiting') state = 'waiting'
                else if (dot?.state === 'working') state = 'working'
                const agent = session.cliToolName === 'claude' ? 'claude' : session.cliToolName === 'codex' ? 'codex' : null
                return {
                    id: session.id,
                    name: session.name,
                    workspaceId: workspace.id,
                    agent,
                    state,
                    ...(state === 'waiting' && dot?.question ? { question: maskLine(dot.question) } : {}),
                    ...(session.sessionFolderId ? { sessionFolderId: session.sessionFolderId } : {}),
                    ...(session.isPinned ? { pinned: true } : {})
                } as const
            })
        )
        const folders = ((deps.store.get('folders') as WorkspaceFolder[] | undefined) ?? []).map((f) => ({ id: f.id, name: f.name }))
        const sessionFolders = ((deps.store.get('sessionFolders') as SessionFolder[] | undefined) ?? []).map((f) => ({ id: f.id, name: f.name }))
        return {
            workspaces: list.map((w) => ({
                id: w.id,
                name: w.name,
                path: w.path.startsWith(home) ? `~${w.path.slice(home.length)}` : w.path,
                ...(w.folderId ? { folderId: w.folderId } : {}),
                ...(w.parentWorkspaceId ? { isWorktree: true } : {})
            })),
            folders,
            sessionFolders,
            sessions: sessions.map((s) => ({ ...s }))
        }
    }
    const sessionExists = (id: string): boolean => findSession(id) !== null

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

    server = new PhoneServer({
        devices,
        push,
        tailscale,
        staticDir: deps.staticDir,
        onStateChange,
        statusPoller: poller,
        listSessions,
        sessionExists,
        conversation: deps.conversation,
        saveAttachment: (name, bytes) => saveChatAttachment(join(os.tmpdir(), 'climanager-chat'), name, bytes),
        maskLine,
        recordPhoneInput: (sessionId, detail) => deps.eventLog.record(sessionId, 'phone-input', detail),
        terminals: deps.terminals,
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
        return server.apply(next)
    })
    ipcMain.handle('phone-start-pairing', (_e, role: unknown): PhoneState => {
        devices.startPairing(role === 'watch' ? 'watch' : 'drive')
        return server.state()
    })
    ipcMain.handle('phone-cancel-pairing', (): PhoneState => {
        devices.cancelPairing()
        return server.state()
    })
    ipcMain.handle('phone-revoke-device', (_e, id: unknown): PhoneState => {
        if (typeof id === 'string') devices.revoke(id)
        return server.state()
    })
    ipcMain.handle('phone-revoke-all', (): PhoneState => {
        devices.revokeAll()
        return server.state()
    })
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
