import { DiffLine } from '../../../shared/types'

/**
 * Builds the message sent to an agent when a reviewer comments on a diff.
 *
 * The file path and line number lead the prompt because relocating the code is
 * the part of review feedback that goes wrong most often — without them the
 * reviewer ends up retyping "in login.tsx, around line 40…" by hand, which is
 * the manual step this whole flow exists to remove.
 *
 * The cited lines are quoted verbatim so the agent can still find the code even
 * if it has edited the file since the diff was rendered and the numbers moved.
 */
export function buildReviewPrompt(path: string, lines: DiffLine[], comment: string): string {
    if (lines.length === 0) {
        return `${path} 를 봐줘\n\n${comment}`
    }

    const numbered = lines.map((line) => {
        const number = line.newNumber ?? line.oldNumber ?? ''
        const marker = line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '
        return `  ${String(number).padStart(4)} |${marker}${line.content}`
    })

    const anchor = lines.find((line) => line.newNumber ?? line.oldNumber)
    const location = anchor ? `${path}:${anchor.newNumber ?? anchor.oldNumber}` : path

    return [`${location} 를 봐줘`, '', ...numbered, '', comment].join('\n')
}
