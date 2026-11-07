import { useEffect, useMemo, useRef } from 'react'
import type { PhoneDocMessage } from '../../../shared/phone'
import { PHONE_DOC_SANDBOX } from '../../../shared/phone'
import { frameAddress, fromDocFrame, parseDocMessage, readDocStore } from './docMessages'

/**
 * The document, in a frame whose code has no origin of its own: it cannot read this page, call the phone API or leave
 * the frame (decision 0011). It can only post messages here, and those are read as what a stranger says.
 */
export function PhoneDocFrame({ url, storeKey, title, inert, onMessage }: { url: string; storeKey: string; title: string; inert: boolean; onMessage: (message: PhoneDocMessage) => void }) {
    const frame = useRef<HTMLIFrameElement>(null)
    const handler = useRef(onMessage)
    handler.current = onMessage
    // once: a new address would reload the page and lose what is being written
    const address = useMemo(() => frameAddress(url, readDocStore(storeKey, window.localStorage)), [url, storeKey])
    useEffect(() => {
        const listen = (event: MessageEvent): void => {
            if (!fromDocFrame(event.source, event.origin, frame.current?.contentWindow)) return
            const message = parseDocMessage(event.data)
            if (message) handler.current(message)
        }
        window.addEventListener('message', listen)
        return () => window.removeEventListener('message', listen)
    }, [])
    return <iframe ref={frame} className="phone-doc-frame" data-testid="phone-doc-frame" title={title} sandbox={PHONE_DOC_SANDBOX} src={address} referrerPolicy="no-referrer" inert={inert} />
}
