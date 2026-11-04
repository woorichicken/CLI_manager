import { createHash, randomBytes, randomInt, timingSafeEqual } from 'crypto'
import type { PhoneRole } from '../../shared/phone'
import type { PhoneDeviceInfo, PhonePairingCode } from '../../shared/types'
import { readPrivateJson, writePrivateJson } from './privateFile'

/**
 * Devices paired with Settings › Phone, for phones that are not this Mac's own
 * Tailscale login (another person's phone, a tagged node, a browser without serve).
 *
 * The Mac shows a six-digit code; the phone types it once and gets a token of its own
 * in an HttpOnly cookie. Only the token's hash is stored, in a 0600 file. A code lives
 * ten minutes and survives five wrong guesses; the sixth guess finds no code. Revoking
 * a device closes its open connections (PhoneServer listens to `onRevoke`).
 *
 * The code rules are ovis `server/devices.ts:23-24,265-300` (MIT, devswha).
 */

export const PAIRING_CODE_TTL_MS = 10 * 60_000
export const PAIRING_CODE_ATTEMPTS = 5
const LAST_SEEN_WRITE_MS = 60_000
const LABEL_MAX = 48
const MAX_DEVICES = 50

interface StoredDevice {
    id: string
    label: string
    role: PhoneRole
    tokenHash: string
    createdAt: number
    lastSeenAt: number | null
}

interface Pending {
    code: string
    role: PhoneRole
    expires: number
    attempts: number
}

export interface MatchedDevice {
    id: string
    label: string
    role: PhoneRole
}

const hash = (token: string): string => createHash('sha256').update(token).digest('hex')

function same(a: string, b: string): boolean {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
}

export function cleanLabel(raw: unknown): string {
    const text = typeof raw === 'string' ? raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim() : ''
    return (text || 'Phone').slice(0, LABEL_MAX)
}

export class PhoneDevices {
    private devices: StoredDevice[]
    private pending: Pending | null = null
    private readonly listeners = new Set<() => void>()
    private readonly revokeListeners = new Set<(deviceId: string | null) => void>()

    constructor(private readonly file: string, private readonly now: () => number = Date.now) {
        const saved = readPrivateJson<{ devices?: StoredDevice[] }>(file)
        this.devices = Array.isArray(saved?.devices) ? saved!.devices.filter((d) => typeof d?.tokenHash === 'string') : []
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    /** `null`: every device was revoked. */
    onRevoke(listener: (deviceId: string | null) => void): () => void {
        this.revokeListeners.add(listener)
        return () => this.revokeListeners.delete(listener)
    }

    list(): PhoneDeviceInfo[] {
        return this.devices.map((d) => ({
            id: d.id,
            label: d.label,
            role: d.role,
            createdAt: new Date(d.createdAt).toISOString(),
            lastSeenAt: d.lastSeenAt === null ? null : new Date(d.lastSeenAt).toISOString()
        }))
    }

    /** The code still usable, without spending a try. */
    activePairing(): PhonePairingCode | null {
        const pending = this.pending
        if (!pending || this.now() > pending.expires || pending.attempts >= PAIRING_CODE_ATTEMPTS) return null
        return { code: pending.code, role: pending.role, expiresAt: new Date(pending.expires).toISOString() }
    }

    /** A fresh code, replacing one still pending. */
    startPairing(role: PhoneRole): PhonePairingCode {
        const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
        this.pending = { code, role, expires: this.now() + PAIRING_CODE_TTL_MS, attempts: 0 }
        this.emit()
        return { code, role, expiresAt: new Date(this.pending.expires).toISOString() }
    }

    cancelPairing(): void {
        if (!this.pending) return
        this.pending = null
        this.emit()
    }

    /** A token for the cookie when the code is right; why not otherwise. */
    pair(rawCode: unknown, rawLabel: unknown): { token: string; device: MatchedDevice } | { error: 'wrong_code' | 'no_code' } {
        const pending = this.pending
        if (!pending || this.now() > pending.expires) {
            this.pending = null
            return { error: 'no_code' }
        }
        const code = typeof rawCode === 'string' ? rawCode.replace(/\D/g, '') : ''
        if (!same(code, pending.code)) {
            pending.attempts += 1
            if (pending.attempts >= PAIRING_CODE_ATTEMPTS) {
                this.pending = null
                this.emit()
            }
            return { error: 'wrong_code' }
        }
        this.pending = null
        const token = randomBytes(32).toString('hex')
        const device: StoredDevice = {
            id: randomBytes(8).toString('hex'),
            label: cleanLabel(rawLabel),
            role: pending.role,
            tokenHash: hash(token),
            createdAt: this.now(),
            lastSeenAt: this.now()
        }
        this.devices.push(device)
        // the oldest pairing goes first; a list this long is forgotten devices
        if (this.devices.length > MAX_DEVICES) this.devices.splice(0, this.devices.length - MAX_DEVICES)
        this.save()
        this.emit()
        return { token, device: { id: device.id, label: device.label, role: device.role } }
    }

    /** The device a cookie's token belongs to. */
    match(token: string | null | undefined): MatchedDevice | null {
        if (!token || !/^[0-9a-f]{64}$/.test(token)) return null
        const tokenHash = hash(token)
        const device = this.devices.find((d) => same(d.tokenHash, tokenHash))
        if (!device) return null
        const now = this.now()
        if (device.lastSeenAt === null || now - device.lastSeenAt > LAST_SEEN_WRITE_MS) {
            device.lastSeenAt = now
            this.save()
            this.emit()
        }
        return { id: device.id, label: device.label, role: device.role }
    }

    /** Still paired: a request or socket judged before a revoke asks again before it types. */
    has(id: string): boolean {
        return this.devices.some((d) => d.id === id)
    }

    revoke(id: string): boolean {
        const before = this.devices.length
        this.devices = this.devices.filter((d) => d.id !== id)
        if (this.devices.length === before) return false
        this.save()
        this.emit()
        for (const listener of this.revokeListeners) listener(id)
        return true
    }

    revokeAll(): void {
        this.devices = []
        this.pending = null
        this.save()
        this.emit()
        for (const listener of this.revokeListeners) listener(null)
    }

    private save(): void {
        try {
            writePrivateJson(this.file, { devices: this.devices })
        } catch (error) {
            console.error('[phone] could not save the device list:', error instanceof Error ? error.message : error)
        }
    }

    private emit(): void {
        for (const listener of this.listeners) listener()
    }
}
