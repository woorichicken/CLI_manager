import { test, expect } from '@playwright/test'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { launchAppWithWorkspaces, closeApp, LaunchResult } from './helpers'

/**
 * T27 — every git operation the app runs through simple-git, end to end.
 *
 * The other specs barely touch the Git panel, so a simple-git major upgrade
 * (v3 → v4 changed imports, option parsing and the environment passed to git)
 * could break it with the whole suite green. This drives each IPC handler
 * against a real repository with a local bare remote, and judges by what git
 * itself reports afterwards — not by the handler's return value alone.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = Record<string, (...args: any[]) => Promise<any>>

const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim()

test.describe('T27 git operations', () => {
    let ctx: LaunchResult
    let root: string

    test.afterEach(async () => {
        if (ctx) await closeApp(ctx)
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    })

    test('status, stage, commit, log, branches, merge, reset, push/pull and worktrees work', async () => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-t27-')))
        const remote = path.join(root, 'remote.git')
        const repo = path.join(root, 'repo')
        git(root, 'init', '-q', '--bare', '-b', 'main', remote)
        git(root, 'clone', '-q', remote, repo)
        git(repo, 'config', 'user.email', 't27@example.com')
        git(repo, 'config', 'user.name', 'T27')
        git(repo, 'checkout', '-q', '-b', 'main')
        fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-q', '-m', 'initial')
        git(repo, 'push', '-q', '-u', 'origin', 'main')

        ctx = await launchAppWithWorkspaces([
            { id: 'ws-git', name: 'T27REPO', path: repo, sessions: [{ id: 's-git', name: 'T27TERM' }] }
        ])
        const { page } = ctx
        await page.locator('[data-session-item="s-git"]').waitFor({ timeout: 10_000 })
        const call = (name: string, ...args: unknown[]): Promise<any> => // eslint-disable-line @typescript-eslint/no-explicit-any
            page.evaluate(([fn, a]) => ((window as unknown as { api: Api }).api)[fn as string](...(a as unknown[])), [name, args])

        // status + stage + commit
        fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n')
        fs.writeFileSync(path.join(repo, 'b.txt'), 'new\n')
        const status = await call('getGitStatus', repo)
        expect(JSON.stringify(status)).toContain('b.txt')
        expect(await call('gitStage', repo, 'a.txt')).toBe(true)
        expect(git(repo, 'diff', '--cached', '--name-only')).toBe('a.txt')
        expect(await call('gitUnstage', repo, 'a.txt')).toBe(true)
        expect(git(repo, 'diff', '--cached', '--name-only')).toBe('')
        expect(await call('gitStageFiles', repo, ['a.txt', 'b.txt'])).toBe(true)
        expect(await call('gitUnstageAll', repo)).toBe(true)
        expect(await call('gitStageAll', repo)).toBe(true)
        expect(await call('gitCommit', repo, 'second')).toBe(true)
        expect(git(repo, 'log', '-1', '--format=%s')).toBe('second')

        const log = await call('gitLog', repo, 5)
        expect(log.map((c: { message: string }) => c.message)).toEqual(['second', 'initial'])

        // push to and pull from the local bare remote
        expect(await call('gitPush', repo)).toBe(true)
        expect(git(remote, 'log', '-1', '--format=%s', 'main')).toBe('second')
        expect(await call('gitPull', repo)).toBe(true)

        // branches: checkout, merge, delete
        git(repo, 'branch', 'feature')
        const branches = await call('gitListBranches', repo)
        expect(branches.current).toBe('main')
        expect(branches.all).toContain('feature')
        expect(await call('gitCheckout', repo, 'feature')).toBe(true)
        fs.writeFileSync(path.join(repo, 'c.txt'), 'feature\n')
        git(repo, 'add', '.')
        git(repo, 'commit', '-q', '-m', 'feature work')
        expect(await call('gitCheckout', repo, 'main')).toBe(true)
        const merge = await call('gitMerge', repo, 'feature')
        expect(merge.success).toBe(true)
        expect(fs.existsSync(path.join(repo, 'c.txt'))).toBe(true)
        expect((await call('gitDeleteBranch', repo, 'feature')).success).toBe(true)
        expect(git(repo, 'branch', '--list', 'feature')).toBe('')

        // merge abort on a real conflict
        git(repo, 'checkout', '-q', '-b', 'clash')
        fs.writeFileSync(path.join(repo, 'a.txt'), 'clash side\n')
        git(repo, 'commit', '-q', '-am', 'clash side')
        git(repo, 'checkout', '-q', 'main')
        fs.writeFileSync(path.join(repo, 'a.txt'), 'main side\n')
        git(repo, 'commit', '-q', '-am', 'main side')
        const conflicted = await call('gitMerge', repo, 'clash')
        expect(JSON.stringify(conflicted)).toContain('a.txt')
        expect((await call('gitMergeAbort', repo)).success).toBe(true)
        expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false)

        // reset: soft keeps the change staged, hard drops it
        const before = git(repo, 'rev-parse', 'HEAD~1')
        expect(await call('gitReset', repo, before, false)).toBe(true)
        expect(git(repo, 'diff', '--cached', '--name-only')).toBe('a.txt')
        expect(await call('gitReset', repo, before, true)).toBe(true)
        expect(git(repo, 'status', '--porcelain')).toBe('')

        // worktrees: add through the app, then the startup sync sees it
        const added = await call('addWorktreeWorkspace', 'ws-git', 't27-wt')
        expect(added.success).toBe(true)
        expect(git(repo, 'worktree', 'list', '--porcelain')).toContain('branch refs/heads/t27-wt')
        const synced = await call('syncWorktreeWorkspaces')
        expect(synced.success).toBe(true)
    })
})
