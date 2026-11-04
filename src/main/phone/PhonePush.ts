import { appendFileSync, existsSync } from 'fs'
import webpush from 'web-push'
import type { PhonePushPayload, PhonePushSubscription, PhoneTestPushResult } from '../../shared/phone'
import type { SessionScreenStatus } from '../../shared/types'
import { readPrivateJson, writePrivateJson } from './privateFile'

/**
 * Web Push to phones that turned alerts on: a session asks a question, or an agent's
 * turn ends. Tapping the alert opens that session's Chat (`url`).
 *
 * - Nothing goes out while someone is at the Mac using the app (`macInUse`): they
 *   already see it (ovis `server/push.ts:40-41`). The test alert always goes.
 * - One alert per session per minute, so twenty agents finishing at once is not twenty
 *   buzzes from one of them.
 * - Keys (VAPID) and subscriptions sit in 0600 files in the app data folder. Their values
 *   are never logged. A push service answering 404/410 dropped the subscription: it is removed.
 * - A key file that is there but unreadable is an error, never a rotation: a new key pair
 *   would orphan every subscribed phone without a word. The file is left as it is and
 *   Settings › Phone says so (`keysProblem`) — ovis server/push.ts:8,363 (MIT).
 *
 * Encryption and signing are the `web-push` package (RFC 8291 / 8292).
 */

const SESSION_GAP_MS = 60_000
/** A turn shorter than this is not worth a buzz (a quick answer you were waiting for at the Mac). */
const FINISH_MIN_WORK_MS = 5_000
const TTL_SECONDS = 60 * 60
/** VAPID contact: the push services want a URL or mailto they can reach the sender at. */
const VAPID_SUBJECT = 'https://climanager.solhun.com'
const MAX_SUBSCRIPTIONS = 50
/**
 * A push service answers in well under a second. One that takes the connection and never answers
 * would hold Test alert (and every later alert's request) open for good: web-push only sets a socket
 * timeout when given one (ovis push.ts:569 uses AbortSignal.timeout the same way).
 */
const PUSH_TIMEOUT_MS = 10_000

interface StoredSubscription extends PhonePushSubscription {
    /** `tailscale:<login>` or `device:<id>` — a revoked device loses its alerts with it */
    owner: string
    createdAt: number
}

interface VapidKeys {
    publicKey: string
    privateKey: string
}

export interface PhonePushDeps {
    keysFile: string
    subscriptionsFile: string
    /** someone is at the Mac with the app in front */
    macInUse(): boolean
    /** the session's name and whether it runs an agent, for the alert text */
    session(id: string): { name: string; agent: boolean } | null
    now?: () => number
    /** tests: a shorter wait than PUSH_TIMEOUT_MS */
    pushTimeoutMs?: number
}

export class PhonePush {
    private keys: VapidKeys | null = null
    private subscriptions: StoredSubscription[]
    private readonly lastSent = new Map<string, number>()
    /** per session: what the screen last said, and since when it was working */
    private readonly seen = new Map<string, { state: SessionScreenStatus['state']; since: number }>()

    constructor(private readonly deps: PhonePushDeps) {
        const saved = readPrivateJson<{ subscriptions?: StoredSubscription[] }>(deps.subscriptionsFile)
        this.subscriptions = Array.isArray(saved?.subscriptions) ? saved!.subscriptions.filter(isSubscription) : []
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now()
    }

    /** The public key a page subscribes with; made on first use. Throws when the key file is malformed. */
    publicKey(): string {
        return this.vapid().publicKey
    }

    /** Why alerts cannot go out (the key file is malformed), or null. Never makes a key. */
    keysProblem(): string | null {
        if (this.keys || !existsSync(this.deps.keysFile)) return null
        try {
            this.vapid()
            return null
        } catch (error) {
            return error instanceof Error ? error.message : String(error)
        }
    }

    count(): number {
        return this.subscriptions.length
    }

    subscribe(subscription: unknown, owner: string): boolean {
        if (!isSubscription(subscription)) return false
        const { endpoint, keys } = subscription
        this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint)
        this.subscriptions.push({ endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, owner, createdAt: this.now() })
        if (this.subscriptions.length > MAX_SUBSCRIPTIONS) this.subscriptions.splice(0, this.subscriptions.length - MAX_SUBSCRIPTIONS)
        this.save()
        return true
    }

    unsubscribe(endpoint: unknown): void {
        if (typeof endpoint !== 'string') return
        const before = this.subscriptions.length
        this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint)
        if (this.subscriptions.length !== before) this.save()
    }

    /** A device was revoked (`null`: all of them): its alerts stop with it. */
    forgetOwner(owner: string | null): void {
        const before = this.subscriptions.length
        this.subscriptions = owner === null ? this.subscriptions.filter((s) => !s.owner.startsWith('device:')) : this.subscriptions.filter((s) => s.owner !== owner)
        if (this.subscriptions.length !== before) this.save()
    }

    /**
     * Screen status changes from the phone server's status poller. A question that
     * appears, or a working turn that ends, becomes an alert.
     */
    onStatus(changes: SessionScreenStatus[]): void {
        const now = this.now()
        for (const change of changes) {
            const before = this.seen.get(change.sessionId)
            if (before?.state === change.state) continue
            this.seen.set(change.sessionId, { state: change.state, since: now })
            const session = this.deps.session(change.sessionId)
            if (!session?.agent) continue
            if (change.state === 'waiting') {
                void this.alert(change.sessionId, {
                    title: `${session.name} needs you`,
                    body: change.question ? clip(change.question) : 'Waiting for your answer'
                })
            } else if (change.state === 'idle' && before?.state === 'working' && now - before.since >= finishMinWorkMs()) {
                void this.alert(change.sessionId, { title: `${session.name} finished`, body: 'The turn ended. Tap to read it.' })
            }
        }
    }

    forgetSession(sessionId: string): void {
        this.seen.delete(sessionId)
        this.lastSent.delete(sessionId)
    }

    async test(): Promise<PhoneTestPushResult> {
        const problem = this.keysProblem()
        if (problem) return { status: 'failed', message: problem }
        if (this.subscriptions.length === 0) {
            return { status: 'none', message: 'No phone has turned alerts on yet. Open the page on the phone and tap Alerts.' }
        }
        const sent = await this.sendAll({ title: 'CLI Manager', body: 'Test alert from your Mac', url: '/', tag: 'climanager-test' })
        return sent > 0 ? { status: 'sent', devices: sent } : { status: 'failed', message: 'Every push service refused the alert.' }
    }

    private async alert(sessionId: string, text: { title: string; body: string }): Promise<void> {
        if (this.subscriptions.length === 0) return
        if (this.deps.macInUse()) return
        const now = this.now()
        const last = this.lastSent.get(sessionId)
        if (last !== undefined && now - last < SESSION_GAP_MS) return
        this.lastSent.set(sessionId, now)
        await this.sendAll({
            ...text,
            url: `/?session=${encodeURIComponent(sessionId)}&view=chat`,
            tag: `session-${sessionId}`
        })
    }

    /** How many subscriptions took it. */
    private async sendAll(payload: PhonePushPayload): Promise<number> {
        const body = JSON.stringify(payload)
        const testLog = process.env.CLIMANGER_TEST_USERDATA ? process.env.CLIMANAGER_PHONE_PUSH_LOG : undefined
        if (testLog) {
            // tests never reach a real push service
            for (const s of this.subscriptions) appendFileSync(testLog, JSON.stringify({ endpoint: s.endpoint, payload }) + '\n')
            return this.subscriptions.length
        }
        let keys: VapidKeys
        try {
            keys = this.vapid()
        } catch (error) {
            // an alert is fire-and-forget (`void this.alert`): a throw here would be an unhandled rejection
            console.error('[phone] alerts not sent:', error instanceof Error ? error.message : error)
            return 0
        }
        let ok = 0
        const gone: string[] = []
        await Promise.all(this.subscriptions.map(async (s) => {
            try {
                await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body, {
                    TTL: TTL_SECONDS,
                    timeout: this.deps.pushTimeoutMs ?? PUSH_TIMEOUT_MS,
                    vapidDetails: { subject: VAPID_SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey }
                })
                ok += 1
            } catch (error) {
                const status = (error as { statusCode?: number }).statusCode
                if (status === 404 || status === 410) gone.push(s.endpoint)
                // the endpoint names the device's push account: log only the status
                else console.warn('[phone] push failed with status', status ?? 'none')
            }
        }))
        if (gone.length > 0) {
            this.subscriptions = this.subscriptions.filter((s) => !gone.includes(s.endpoint))
            this.save()
        }
        return ok
    }

    private vapid(): VapidKeys {
        if (this.keys) return this.keys
        if (existsSync(this.deps.keysFile)) {
            const saved = readPrivateJson<Partial<VapidKeys>>(this.deps.keysFile)
            if (saved && typeof saved.publicKey === 'string' && typeof saved.privateKey === 'string') {
                this.keys = { publicKey: saved.publicKey, privateKey: saved.privateKey }
                return this.keys
            }
            throw new Error('The alert key file (vapid.json) is malformed; restore it, or delete it and turn Alerts on again on every phone.')
        }
        const fresh = webpush.generateVAPIDKeys()
        writePrivateJson(this.deps.keysFile, fresh)
        this.keys = fresh
        return fresh
    }

    private save(): void {
        try {
            writePrivateJson(this.deps.subscriptionsFile, { subscriptions: this.subscriptions })
        } catch (error) {
            console.error('[phone] could not save alert subscriptions:', error instanceof Error ? error.message : error)
        }
    }
}

function finishMinWorkMs(): number {
    const override = process.env.CLIMANGER_TEST_USERDATA ? Number(process.env.CLIMANAGER_PHONE_FINISH_MIN_MS) : NaN
    return Number.isFinite(override) ? override : FINISH_MIN_WORK_MS
}

function clip(text: string): string {
    const line = text.replace(/\s+/g, ' ').trim()
    return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

/** Bytes a base64url key decodes to; -1 when it is not base64url at all. */
function decodedLength(value: unknown): number {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+=*$/.test(value)) return -1
    return Buffer.from(value, 'base64url').length
}

/**
 * The PushSubscription JSON a browser produces: an https endpoint, p256dh an uncompressed P-256
 * point (65 bytes), auth a 16-byte secret (RFC 8291). Anything else no push service issued, and
 * web-push would only fail on it at send time (ovis server/push.ts:255-276, MIT).
 */
function isSubscription(value: unknown): value is PhonePushSubscription {
    const v = value as PhonePushSubscription | null
    if (!v || typeof v !== 'object' || typeof v.endpoint !== 'string' || v.endpoint.length >= 2048) return false
    try {
        if (new URL(v.endpoint).protocol !== 'https:') return false
    } catch {
        return false
    }
    return !!v.keys && decodedLength(v.keys.p256dh) === 65 && decodedLength(v.keys.auth) === 16
}
