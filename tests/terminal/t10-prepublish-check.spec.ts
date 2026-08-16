import { test, expect } from '@playwright/test'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'
import { REPO_ROOT } from './helpers'

/**
 * T10 — Pre-publish hygiene gate.
 *
 * This repository is public, so the checker is the last thing standing between
 * a mistake and a permanent commit. A gate nobody verified is worse than no
 * gate: it reports "clean" and everyone believes it.
 *
 * Each test therefore plants the exact problem it claims to catch inside a
 * throwaway git repository and asserts the checker fails.
 */

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'prepublish-check.cjs')

interface Result {
    code: number
    output: string
}

/**
 * Runs the checker copied into `repo`, returning its exit code and output.
 *
 * The copy matters: the checker derives its repository root from its own
 * location, so running the original would silently scan this repository
 * instead of the fixture — which is exactly what happened the first time.
 */
function runChecker(repo: string, args: string[] = []): Result {
    const copied = path.join(repo, 'scripts', 'prepublish-check.cjs')
    try {
        const output = execFileSync('node', [copied, ...args], { cwd: repo, encoding: 'utf-8', stdio: 'pipe' })
        return { code: 0, output }
    } catch (error: any) {
        return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }
    }
}

/**
 * Builds a minimal committed repository.
 *
 * The checker resolves its root from its own location, so the fixture copies
 * the script in and runs it from there.
 */
function makeRepo(files: Record<string, string>, forceAdd: string[] = []): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'climanger-prepub-'))
    const git = (args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' })

    git(['init', '-q', '-b', 'main'])
    git(['config', 'user.email', 'test@example.com'])
    git(['config', 'user.name', 'Test'])

    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true })
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'prepublish-check.cjs'))

    for (const [rel, contents] of Object.entries(files)) {
        const full = path.join(dir, rel)
        fs.mkdirSync(path.dirname(full), { recursive: true })
        fs.writeFileSync(full, contents)
    }

    git(['add', '-A'])
    // `git add -A` honours .gitignore, so reproducing "tracked before the rule
    // existed" requires forcing those paths in explicitly.
    for (const rel of forceAdd) git(['add', '-f', rel])
    git(['commit', '-q', '-m', 'fixture'])
    return dir
}

test.describe('T10 prepublish-check', () => {
    test('a clean repository passes', () => {
        const dir = makeRepo({ 'src/app.ts': 'export const value = 1\n' })
        try {
            const result = runChecker(dir)
            expect(result.output).toContain('PASS')
            expect(result.code).toBe(0)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('vendor-prefixed API keys are caught', () => {
        const cases: Array<[string, string]> = [
            ['openai', "const k = 'sk-abcdefghij0123456789ABCDEFghijkl'\n"],
            ['github', "const k = 'ghp_abcdefghij0123456789ABCDEFghijklmnop'\n"],
            ['aws', "const k = 'AKIAIOSFODNN7EXAMPLE'\n"],
            ['private-key', '-----BEGIN RSA PRIVATE KEY-----\nMIIB\n'],
        ]

        for (const [label, contents] of cases) {
            const dir = makeRepo({ 'src/leak.ts': contents })
            try {
                const result = runChecker(dir, ['--only=secrets'])
                expect(result.output, `${label} must be caught`).toContain('FAIL')
                expect(result.code, `${label} must fail the run`).toBe(1)
            } finally {
                fs.rmSync(dir, { recursive: true, force: true })
            }
        }
    })

    test('a credential with no vendor prefix is caught by its variable name', () => {
        // The real case this was added for: an S3-compatible key is just a long
        // random string, so only the assignment target identifies it.
        const dir = makeRepo({
            'scripts/upload.js':
                "const R2_ACCESS_KEY_ID = '4cf0d47495e28d4a4a003e4eb5fed668';\n" +
                "const R2_SECRET_ACCESS_KEY = '3a7d3141d095418c18dbeb6a148f3f7fb212d63670e4d343d991d8adaf42a514';\n"
        })
        try {
            const result = runChecker(dir, ['--only=secrets'])
            expect(result.output).toContain('FAIL')
            expect(result.code).toBe(1)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('an env-var reference is not mistaken for a credential', () => {
        const dir = makeRepo({
            'scripts/upload.js':
                'const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY\n' +
                "console.error('export R2_SECRET_ACCESS_KEY=\"your-secret-access-key\"')\n"
        })
        try {
            const result = runChecker(dir, ['--only=secrets'])
            // A gate that flags the correct pattern trains people to skip it.
            expect(result.output).toContain('PASS')
            expect(result.code).toBe(0)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('a tracked file matched by .gitignore is reported', () => {
        const dir = makeRepo(
            { '.gitignore': 'config/\n', 'config/rules.md': '# shared rule\n' },
            ['config/rules.md']
        )
        try {
            // The trap: config/rules.md is already tracked, so the ignore rule
            // is invisible until someone adds a sibling file and it vanishes.
            const result = runChecker(dir, ['--only=ignored-but-tracked'])
            expect(result.output).toContain('ignored-but-tracked')
            expect(result.code).toBe(1)
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })

    test('an unknown check name is rejected instead of silently doing nothing', () => {
        const dir = makeRepo({ 'src/app.ts': 'export const value = 1\n' })
        try {
            const result = runChecker(dir, ['--only=does-not-exist'])
            expect(result.code).toBe(1)
            expect(result.output).toContain('Unknown check')
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})
