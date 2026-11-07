import type { PhoneDockResponse, PhoneMe, PhonePairResult, PhonePushSubscription, PhoneSessionsResponse, PhoneTestPushResult } from '../../../shared/phone'
import { PHONE_API } from '../../../shared/phone'

/**
 * The phone page's calls to the Mac. Same origin as the page (the phone server, behind
 * `tailscale serve`), so the paired-device cookie rides along by itself.
 */

export class PhoneApiError extends Error {
    constructor(readonly status: number, readonly code: string, message: string) {
        super(message)
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, { credentials: 'same-origin', ...init })
    let body: unknown = null
    try {
        body = await response.json()
    } catch {
        body = null
    }
    if (!response.ok && !(body && typeof body === 'object' && 'status' in body)) {
        const code = (body as { error?: string } | null)?.error ?? 'error'
        const message = (body as { message?: string } | null)?.message ?? `${response.status} ${code}`
        throw new PhoneApiError(response.status, code, message)
    }
    return body as T
}

export const postJson = <T>(path: string, body: unknown): Promise<T> =>
    request<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) })

export const getJson = <T>(path: string): Promise<T> => request<T>(path)

export const getMe = (): Promise<PhoneMe> => getJson<PhoneMe>(PHONE_API.me)

export const pair = (code: string, label: string): Promise<PhonePairResult> => postJson<PhonePairResult>(PHONE_API.pair, { code, label })

export const getSessions = (): Promise<PhoneSessionsResponse> => getJson<PhoneSessionsResponse>(PHONE_API.sessions)

export const getDock = (): Promise<PhoneDockResponse> => getJson<PhoneDockResponse>(PHONE_API.dock)

export const subscribePush = (subscription: PhonePushSubscription): Promise<unknown> => postJson(PHONE_API.pushSubscribe, { subscription })

export const unsubscribePush = (endpoint: string): Promise<unknown> => postJson(PHONE_API.pushUnsubscribe, { endpoint })

export const testPush = (): Promise<PhoneTestPushResult> => postJson<PhoneTestPushResult>(PHONE_API.pushTest, {})

export const chatPath = (sessionId: string, action: string): string => `${PHONE_API.chat}/${encodeURIComponent(sessionId)}/${action}`

/** ws:// or wss:// on this page's own host. */
export function socketUrl(path: string): string {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${scheme}//${window.location.host}${path}`
}
