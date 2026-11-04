// From ovis (https://github.com/devswha/ovis, 3e51902) — MIT, Copyright (c) 2026 devswha. Modified.
// Source: server/claude-subagents.ts — only `taskNotification` and the two types the parser reads.
// Reading a subagent's own files (titles, live progress) is not ported: a card shows what the
// notification itself says.

const AGENT_ID = /^[A-Za-z0-9_-]+$/

export interface TaskNotification {
    taskId: string
    toolUseId: string | null
    status: 'completed' | 'failed' | 'cancelled'
    summary: string
    result: string
    /** whether it is a subagent's: a background command and a monitor use the same block */
    agent: boolean
}

/** What a subagent's meta file says of it; the chat passes none (empty map). */
export interface SubagentDetail {
    title: string | null
    agent: string | null
}

/**
 * Claude Code writes the notification's text XML-escaped (`programs &amp; keywords` in a real
 * transcript, where the subagent's own record has `&`). One pass, so `&amp;lt;` stays `&lt;`.
 */
const XML_ENTITY = /&(amp|lt|gt|quot|apos|#\d{1,7}|#x[0-9a-f]{1,6});/gi
const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

export function decodeXmlEntities(text: string): string {
    return text.replace(XML_ENTITY, (whole, name: string) => {
        const named = NAMED_ENTITIES[name.toLowerCase()]
        if (named !== undefined) return named
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
        return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
}

export function taskNotification(content: string): TaskNotification | null {
    const block = content.trim()
    if (!block.startsWith('<task-notification>') || !block.endsWith('</task-notification>')) return null
    const tag = (name: string): string | null => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null
    const taskId = tag('task-id')
    const raw = tag('status')
    const escapedSummary = tag('summary')
    const summary = escapedSummary === null ? null : decodeXmlEntities(escapedSummary)
    if (taskId === null || !AGENT_ID.test(taskId) || raw === null || summary === null) return null
    // the answer may quote the closing tag itself: it runs to the last one
    const from = block.indexOf('<result>')
    const to = block.lastIndexOf('</result>')
    return {
        taskId,
        toolUseId: tag('tool-use-id'),
        status: raw === 'completed' ? 'completed' : raw === 'failed' || raw === 'error' ? 'failed' : 'cancelled',
        summary,
        result: from !== -1 && to > from ? block.slice(from + '<result>'.length, to).trim() : '',
        agent: summary.startsWith('Agent "')
    }
}
