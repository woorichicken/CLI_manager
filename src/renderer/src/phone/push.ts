import type { PhonePushSubscription } from '../../../shared/phone'
import { subscribePush, unsubscribePush } from './api'

/**
 * Turning the Mac's alerts on for this phone: the service worker (sw.js) holds a push
 * subscription made with the Mac's public key, and the Mac sends to it. An iPhone needs
 * the page added to the Home Screen and iOS 16.4+; a page opened in a tab cannot subscribe.
 */

export type AlertsState = 'on' | 'off' | 'unsupported' | 'denied'

function supported(): boolean {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export async function registerWorker(): Promise<void> {
    if (!('serviceWorker' in navigator)) return
    try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' })
    } catch (error) {
        console.warn('[phone] service worker not registered:', error)
    }
}

export async function alertsState(): Promise<AlertsState> {
    if (!supported()) return 'unsupported'
    if (Notification.permission === 'denied') return 'denied'
    const registration = await navigator.serviceWorker.getRegistration('/')
    const subscription = await registration?.pushManager.getSubscription()
    return subscription ? 'on' : 'off'
}

function keyBytes(base64url: string): Uint8Array {
    const padded = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
    const raw = atob(padded)
    return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

export async function enableAlerts(publicKey: string): Promise<AlertsState> {
    if (!supported()) return 'unsupported'
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') return 'denied'
    const registration = await navigator.serviceWorker.ready
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
        subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(publicKey) as BufferSource
        })
    }
    await subscribePush(subscription.toJSON() as PhonePushSubscription)
    return 'on'
}

export async function disableAlerts(): Promise<AlertsState> {
    if (!supported()) return 'unsupported'
    const registration = await navigator.serviceWorker.getRegistration('/')
    const subscription = await registration?.pushManager.getSubscription()
    if (subscription) {
        await unsubscribePush(subscription.endpoint).catch(() => undefined)
        await subscription.unsubscribe()
    }
    return 'off'
}
