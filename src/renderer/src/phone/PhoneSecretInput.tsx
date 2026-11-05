import { useEffect, useRef, useState } from 'react'
import { LockKeyhole, Send } from 'lucide-react'
import { validSecret } from './secretPrompt'

/**
 * The input line while the Mac's terminal asks for a password (sudo, ssh, a passphrase): a password
 * field whose value lives only in the DOM — no React state, no draft, no retry copy — wiped when it
 * is sent, when the page is hidden or left, when the prompt goes away (this unmounts), and when
 * another prompt takes its place or the connection changes.
 * After ovis src/components/SecretInput.tsx (MIT).
 */
export function PhoneSecretInput({ prompt, connected, onSend }: { prompt: string; connected: boolean; onSend: (value: string) => boolean }) {
    const input = useRef<HTMLInputElement>(null)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => {
        const clear = (): void => {
            if (input.current) input.current.value = ''
        }
        const hidden = (): void => {
            if (document.hidden) clear()
        }
        document.addEventListener('visibilitychange', hidden)
        window.addEventListener('pagehide', clear)
        return () => {
            clear()
            document.removeEventListener('visibilitychange', hidden)
            window.removeEventListener('pagehide', clear)
        }
    }, [])

    // Another prompt in this one's place (ssh to another host, sudo after ssh), or the connection
    // dropped and came back: what was typed was for the prompt before — never sent to the new one
    // (round2 N02). The cleanup runs before the effect for the new prompt.
    useEffect(
        () => () => {
            if (input.current) input.current.value = ''
            setError(null)
        },
        [prompt, connected]
    )

    return (
        <form
            className="phone-line phone-secret"
            data-testid="phone-terminal-secret-form"
            onSubmit={(event) => {
                event.preventDefault()
                const field = input.current
                if (!field || !connected) return
                let value = field.value
                field.value = ''
                if (!validSecret(value)) {
                    setError('Enter a single-line password or PIN.')
                    return
                }
                const sent = onSend(value)
                value = ''
                setError(sent ? null : 'Not sent — check the terminal before entering it again.')
            }}
        >
            <label className="phone-secret-label">
                <LockKeyhole size={13} aria-hidden="true" />
                <span className="phone-secret-prompt">{prompt}</span>
            </label>
            <div className="phone-secret-row">
                <input
                    ref={input}
                    type="password"
                    data-testid="phone-terminal-secret"
                    aria-label="Password or PIN"
                    placeholder="Sent straight to the terminal, never kept"
                    autoComplete="off"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    maxLength={4096}
                    enterKeyHint="send"
                />
                <button type="submit" aria-label="Send" data-testid="phone-terminal-secret-send" disabled={!connected}>
                    <Send size={15} />
                </button>
            </div>
            {error && (
                <p className="phone-secret-error" role="status">
                    {error}
                </p>
            )}
        </form>
    )
}
