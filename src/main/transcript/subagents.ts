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

export function taskNotification(content: string): TaskNotification | null {
    const block = content.trim()
    if (!block.startsWith('<task-notification>') || !block.endsWith('</task-notification>')) return null
    const tag = (name: string): string | null => block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1]?.trim() ?? null
    const taskId = tag('task-id')
    const raw = tag('status')
    const summary = tag('summary')
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
