/**
 * "The person typed into this session" — a keystroke in its terminal or a message sent from its Chat.
 * The tab row listens: typing in a preview tab keeps it (the way editing keeps a VS Code preview tab).
 * A window event, not a prop, because the terminal and the Chat box sit far below the tab row.
 */
export const SESSION_INPUT_EVENT = 'climanager:session-input'

export function noteSessionInput(sessionId: string): void {
    window.dispatchEvent(new CustomEvent<{ sessionId: string }>(SESSION_INPUT_EVENT, { detail: { sessionId } }))
}
