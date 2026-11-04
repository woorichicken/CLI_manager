/**
 * Chat messages a phone left waiting in a session's queue (ConversationService, F03) go when the
 * phone loses access: a device disconnected (PhoneServer `onDeviceRevoked`, the 51st pairing
 * included), every device at once, or the phone connection turned off. Queued text is typed into
 * the terminal on its own later, so it must not outlive the access it was sent with.
 */

/** ConversationService, as far as this needs it. */
export interface QueuedFromPhone {
    dropQueuedFrom(origin: string | ((origin: string | undefined) => boolean)): number
}

export function phoneQueueHooks(conversation: QueuedFromPhone): { deviceRevoked(deviceId: string | null): number; phoneOff(): number } {
    return {
        // `null`: Disconnect all — the owner signed in through Tailscale keeps access
        deviceRevoked: (deviceId) =>
            conversation.dropQueuedFrom(deviceId === null ? (origin) => origin?.startsWith('device:') ?? false : `device:${deviceId}`),
        // anything a phone sent (`device:<id>`, `tailscale:<login>`); the Mac's own sends carry no origin
        phoneOff: () => conversation.dropQueuedFrom((origin) => origin !== undefined)
    }
}
