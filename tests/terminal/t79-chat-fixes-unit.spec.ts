import { test, expect } from '@playwright/test'
import { agentTaskResult } from '../../src/main/transcript/records'
import { taskNotification } from '../../src/main/transcript/subagents'

/**
 * T79 — Chat fixes from the 11-03 cross review (codex-xreview F03 · F04 · F09 · F10 · F11 · F12 · F18)
 * and the ovis comparison (가1 · 다1), without Electron. Each block was written against the code
 * before its fix and failed there first.
 */

/** Claude Code writes a subagent's `<task-notification>` XML-escaped (seen in real transcripts). */
function escapedNotification(summary: string, result: string): string {
    const escape = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return [
        '<task-notification>',
        '<task-id>a1b2c3d4e5</task-id>',
        '<tool-use-id>toolu_01ABC</tool-use-id>',
        '<status>completed</status>',
        `<summary>${escape(summary)}</summary>`,
        `<result>${escape(result)}</result>`,
        '</task-notification>'
    ].join('\n')
}

test.describe('T79 subagent cards decode the XML entities of the notification (ovis 가1 · 다1)', () => {
    const title = 'Survey programs & keywords <draft>'
    const summary = `Agent "${title}" completed`
    const result = 'Tracker & Newbie > Share & Earn — a <b> tag stays text, &amp; stays as typed'

    test('가1: the card title has the summary’s own characters', () => {
        const notice = taskNotification(escapedNotification(summary, result))!
        expect(notice).not.toBeNull()
        expect(notice.agent).toBe(true)
        expect(agentTaskResult(notice, undefined).title).toBe(title)
    })

    test('다1: the result body has the subagent’s own characters', () => {
        const notice = taskNotification(escapedNotification(summary, result))!
        expect(agentTaskResult(notice, undefined).result).toBe(result)
    })
})
