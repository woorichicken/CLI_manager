import { test, expect } from '@playwright/test'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { BackgroundTaskReader, settleBackground } from '../../src/main/transcript/backgroundTasks'
import type { BackgroundTask } from '../../src/shared/conversation'

/**
 * T124 — the background chip's list, read from a Claude transcript the way ovis reads it (fb-1110
 * a0ba98c4 4회차). Record shapes and cases follow ovis' own tests (refs/ovis 3e51902
 * server/claude-subagents.test.ts — MIT, Copyright (c) 2026 devswha): a subagent's pair of files beside
 * the transcript, its notification in three carriers, a background `Bash` call and its end.
 */

const NOW = Date.parse('2026-11-10T12:00:00.000Z')
const at = (minutes: number): string => new Date(NOW - 60 * 60 * 1000 + minutes * 60 * 1000).toISOString()
const json = (value: unknown): string => `${JSON.stringify(value)}\n`
const SESSION = '11111111-1111-4111-8111-111111111111'

const roots: string[] = []
test.afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function session() {
    const root = mkdtempSync(join(tmpdir(), 'climanager-t124-'))
    roots.push(root)
    const path = join(root, 'projects', 'p', `${SESSION}.jsonl`)
    const dir = join(root, 'projects', 'p', SESSION, 'subagents')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path, json({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'go' } }))
    const s = {
        path,
        parent: (entry: unknown) => appendFileSync(path, json(entry)),
        agent(id: string, options: { description?: string; type?: string; toolUseId?: string; minutes?: number[] } = {}) {
            writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType: options.type ?? 'reviewer', description: options.description ?? `task ${id}`, toolUseId: options.toolUseId ?? `toolu_${id}` }))
            writeFileSync(join(dir, `agent-${id}.jsonl`), '')
            for (const minute of options.minutes ?? [1, 2]) s.work(id, minute)
        },
        work(id: string, minute: number) {
            appendFileSync(join(dir, `agent-${id}.jsonl`), json({ isSidechain: true, sessionId: SESSION, agentId: id, type: 'assistant', timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } }))
        },
        /** a Bash call sent to the background */
        bash(taskId: string, minute: number, options: { description?: string; command?: string } = {}) {
            s.parent({ type: 'assistant', timestamp: at(minute), message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${taskId}`, name: 'Bash', input: { command: options.command ?? 'pnpm test', ...(options.description === undefined ? {} : { description: options.description }), run_in_background: true } }] } })
            s.parent({ type: 'user', timestamp: at(minute), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${taskId}`, content: `Command running in background with ID: ${taskId}.` }] }, toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false, backgroundTaskId: taskId } })
        },
        notify(id: string, minute: number, options: { status?: string; summary?: string; carriers?: ('user' | 'queue' | 'attachment')[] } = {}) {
            const block = `<task-notification>\n<task-id>${id}</task-id>\n<tool-use-id>toolu_${id}</tool-use-id>\n<status>${options.status ?? 'completed'}</status>\n<summary>${options.summary ?? `Agent "task ${id}" finished`}</summary>\n<result>the answer</result>\n</task-notification>`
            const timestamp = at(minute)
            for (const carrier of options.carriers ?? ['queue', 'user', 'attachment']) {
                s.parent(
                    carrier === 'queue'
                        ? { type: 'queue-operation', operation: 'enqueue', timestamp, content: block }
                        : carrier === 'user'
                          ? { type: 'user', timestamp, message: { role: 'user', content: block } }
                          : { type: 'attachment', timestamp, attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: block } }
                )
            }
        }
    }
    return s
}

const ids = (reader: BackgroundTaskReader, path: string): string[] => reader.read(path, NOW).map((task) => `${task.id}:${task.status}`)

test.describe('T124 subagents, as ovis reads them', () => {
    test('a subagent nothing has ended runs, with its description, type and first entry', () => {
        const s = session()
        s.agent('a1', { description: 'Review the parser', type: 'reviewer', minutes: [1, 2] })
        expect(new BackgroundTaskReader().read(s.path, NOW)).toEqual([
            { id: 'a1', kind: 'agent', title: 'Review the parser', agent: 'reviewer', status: 'running', startedAt: at(1), endedAt: null }
        ])
    })

    test('a notification counts once however many records carry it; failed and killed as they say', () => {
        const s = session()
        s.agent('a1')
        s.agent('a2')
        s.agent('a3')
        s.notify('a1', 3)
        s.notify('a2', 4, { status: 'failed' })
        s.notify('a3', 5, { status: 'killed', summary: 'Agent "task a3" was stopped by Claude' })
        const reader = new BackgroundTaskReader()
        expect(ids(reader, s.path)).toEqual(['a3:cancelled', 'a2:failed', 'a1:completed'])
        expect(reader.read(s.path, NOW).find((task) => task.id === 'a1')?.endedAt).toBe(at(3))
    })

    test("a background command's notification is not an agent's", () => {
        const s = session()
        s.agent('a1')
        s.notify('a1', 3, { summary: 'Background command "sleep" completed (exit code 0)' })
        expect(ids(new BackgroundTaskReader(), s.path)).toEqual(['a1:running'])
    })

    test('an agent whose file has entries after its notification was resumed: running again, then ended again', () => {
        const s = session()
        const reader = new BackgroundTaskReader()
        s.agent('a1')
        s.notify('a1', 3)
        expect(ids(reader, s.path)).toEqual(['a1:completed'])
        s.work('a1', 5)
        expect(ids(reader, s.path)).toEqual(['a1:running'])
        s.notify('a1', 6)
        expect(ids(reader, s.path)).toEqual(['a1:completed'])
    })

    test('a synchronous call ends with its tool_result; a background launch acknowledgement is no answer', () => {
        const s = session()
        s.agent('sync', { toolUseId: 'toolu_sync' })
        s.agent('bg', { toolUseId: 'toolu_bg' })
        for (const id of ['sync', 'bg']) s.parent({ type: 'assistant', timestamp: at(1), message: { role: 'assistant', content: [{ type: 'tool_use', id: `toolu_${id}`, name: 'Agent', input: { description: `task ${id}` } }] } })
        s.parent({ type: 'user', timestamp: at(1), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }] }, toolUseResult: { status: 'async_launched' } })
        s.parent({ type: 'user', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sync', content: 'done', is_error: true }] } })
        expect(ids(new BackgroundTaskReader(), s.path)).toEqual(['bg:running', 'sync:failed'])
    })

    test('TaskStop on an agent stops it', () => {
        const s = session()
        s.agent('a1')
        s.parent({ type: 'assistant', timestamp: at(3), message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_stop', name: 'TaskStop', input: { task_id: 'a1' } }] } })
        s.parent({ type: 'user', timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_stop', content: 'stopped' }] }, toolUseResult: { task_id: 'a1', task_type: 'local_agent' } })
        expect(ids(new BackgroundTaskReader(), s.path)).toEqual(['a1:cancelled'])
    })
})

test.describe('T124 background commands', () => {
    test('a Bash call sent to the background runs under its description, else its command', () => {
        const s = session()
        s.bash('b1', 1, { description: 'Run the test suite' })
        s.bash('b2', 2, { command: 'tail -f build.log' })
        expect(new BackgroundTaskReader().read(s.path, NOW)).toEqual([
            { id: 'b1', kind: 'shell', title: 'Run the test suite', agent: null, status: 'running', startedAt: at(1), endedAt: null },
            { id: 'b2', kind: 'shell', title: 'tail -f build.log', agent: null, status: 'running', startedAt: at(2), endedAt: null }
        ])
    })

    test("its notification ends it (exit code status), TaskStop's answer and KillShell's shell_id stop it", () => {
        const s = session()
        s.bash('b1', 1)
        s.bash('b2', 1)
        s.bash('b3', 1)
        s.notify('b1', 3, { status: 'failed', summary: 'Background command "pnpm test" failed with exit code 1', carriers: ['user'] })
        s.parent({ type: 'user', timestamp: at(4), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_x', content: 'ok' }] }, toolUseResult: { task_id: 'b2', task_type: 'local_bash' } })
        s.parent({ type: 'user', timestamp: at(5), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_y', content: 'ok' }] }, toolUseResult: { shell_id: 'b3' } })
        expect(ids(new BackgroundTaskReader(), s.path)).toEqual(['b3:cancelled', 'b2:cancelled', 'b1:failed'])
    })

    test('an end written before the launch is of an earlier command with that id', () => {
        const s = session()
        s.notify('b1', 1, { summary: 'Background command "old" completed', carriers: ['user'] })
        s.bash('b1', 2)
        expect(ids(new BackgroundTaskReader(), s.path)).toEqual(['b1:running'])
    })

    test('reads on as the transcript grows; a replaced transcript is read anew', () => {
        const s = session()
        const reader = new BackgroundTaskReader()
        s.bash('b1', 1)
        expect(ids(reader, s.path)).toEqual(['b1:running'])
        s.notify('b1', 3, { summary: 'Background command "pnpm test" completed', carriers: ['user'] })
        expect(ids(reader, s.path)).toEqual(['b1:completed'])
        writeFileSync(s.path, json({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'again' } }))
        s.bash('b9', 7)
        expect(ids(reader, s.path)).toEqual(['b9:running'])
    })

    test('the first read covers the window only: a launch above it is not found, the line it starts in is skipped', () => {
        const s = session()
        s.bash('old', 1)
        s.parent({ type: 'user', timestamp: at(2), message: { role: 'user', content: 'x'.repeat(4000) } })
        s.bash('new', 3)
        expect(ids(new BackgroundTaskReader({ window: 2000 }), s.path)).toEqual(['new:running'])
    })

    test('what ended more than a day ago is not listed; ten ended at most, newest first', () => {
        const s = session()
        for (let n = 0; n < 12; n++) {
            s.bash(`b${n}`, 1)
            s.notify(`b${n}`, 2 + n, { summary: `Background command "c${n}" completed`, carriers: ['user'] })
        }
        const listed = ids(new BackgroundTaskReader(), s.path)
        expect(listed).toHaveLength(10)
        expect(listed[0]).toBe('b11:completed')
        expect(new BackgroundTaskReader().read(s.path, NOW + 2 * 24 * 60 * 60 * 1000)).toEqual([])
    })
})

test.describe('T124 the screen count settles what still runs', () => {
    const task = (id: string, kind: 'shell' | 'agent', minute: number, status: BackgroundTask['status'] = 'running'): BackgroundTask => ({ id, kind, title: id, agent: null, status, startedAt: at(minute), endedAt: null })

    test('at rest, running ones beyond Claude\'s count are the oldest, left by an ended process: lost', () => {
        const tasks = [task('s1', 'shell', 1), task('s2', 'shell', 2), task('a1', 'agent', 3)]
        const settled = settleBackground(tasks, { shells: 1, agents: 1 }, true)
        expect(settled.tasks.map((one) => `${one.id}:${one.status}`)).toEqual(['s2:running', 'a1:running', 's1:lost'])
        expect(settled.moreRunning).toBe(0)
    })

    test('while a turn works the transcript stands (a synchronous agent is not in the count)', () => {
        const tasks = [task('a1', 'agent', 1)]
        expect(settleBackground(tasks, null, false).tasks).toEqual(tasks)
    })

    test('what the count holds that the transcript does not show yet is told as more running', () => {
        expect(settleBackground([task('s1', 'shell', 1)], { shells: 2, agents: 1 }, true).moreRunning).toBe(2)
    })
})
