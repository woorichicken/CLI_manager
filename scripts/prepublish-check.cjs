#!/usr/bin/env node
/**
 * Pre-publish hygiene gate for a public repository.
 *
 * Checks the things that are cheap to get wrong and expensive to undo once a
 * commit is public: a leaked credential, a personal absolute path, a file the
 * author believes is committed but is silently ignored.
 *
 * Scope is deliberately **tracked content only** (`git ls-files`). Local
 * scratch files are not the repository's problem, and scanning them produces
 * noise that trains people to ignore this script.
 *
 * Usage:
 *   node scripts/prepublish-check.cjs              # every check
 *   node scripts/prepublish-check.cjs --only=secrets
 *   node scripts/prepublish-check.cjs --list       # show check names
 *
 * Exit code 0 = clean, 1 = at least one failure. Warnings never fail the run.
 */

const { execFileSync } = require('child_process')
const { readFileSync, statSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')

const failures = []
const warnings = []

function fail(check, message, detail) {
    failures.push({ check, message, detail })
}

function warn(check, message, detail) {
    warnings.push({ check, message, detail })
}

function git(args) {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 })
}

function trackedFiles() {
    return git(['ls-files', '-z']).split('\0').filter(Boolean)
}

/** Text files only; a binary match would be a false positive anyway. */
function readTextFile(relPath) {
    try {
        const full = join(ROOT, relPath)
        if (statSync(full).size > 2 * 1024 * 1024) return null
        const buffer = readFileSync(full)
        if (buffer.includes(0)) return null
        return buffer.toString('utf-8')
    } catch {
        return null
    }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
    [/\bsk-[A-Za-z0-9_-]{20,}/, 'OpenAI-style API key'],
    [/\bsk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
    [/\bghp_[A-Za-z0-9]{30,}/, 'GitHub personal access token'],
    [/\bgithub_pat_[A-Za-z0-9_]{50,}/, 'GitHub fine-grained token'],
    [/\bxai-[A-Za-z0-9]{20,}/, 'xAI API key'],
    [/\bntn_[A-Za-z0-9]{30,}/, 'Notion integration token'],
    [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key id'],
    [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, 'private key'],
    [/\bhb_[a-f0-9]{28,}/, 'Hyperbrowser API key'],
    // Vendor-prefix patterns miss keys that are just long random strings, which
    // is what most S3-compatible services issue. Anchor on the variable name.
    [
        /(?:SECRET|ACCESS_KEY|PRIVATE_KEY|API_KEY|AUTH_TOKEN|PASSWORD)[A-Z_]*\s*[:=]\s*['"`][A-Za-z0-9+/_-]{24,}['"`]/i,
        'credential assigned to a secret-named variable'
    ]
]

function checkSecrets(files) {
    for (const file of files) {
        // This file necessarily contains the patterns it searches for.
        if (file === 'scripts/prepublish-check.cjs') continue

        const content = readTextFile(file)
        if (content === null) continue

        for (const [pattern, label] of SECRET_PATTERNS) {
            const match = pattern.exec(content)
            if (!match) continue
            const line = content.slice(0, match.index).split('\n').length
            fail('secrets', `${label} committed`, `${file}:${line}`)
        }
    }
}

/**
 * A personal home directory in tracked content leaks the author's username and
 * breaks for everyone else.
 */
function checkPersonalPaths(files) {
    const pattern = /\/(?:Users|home)\/(?!someone\b|you\b|user\b|USER\b|runner\b)[A-Za-z0-9._-]+\//

    for (const file of files) {
        if (file === 'scripts/prepublish-check.cjs') continue
        // Recorded history and fixtures legitimately contain the paths that
        // existed when they were captured.
        if (file.startsWith('docs/legacy/')) continue

        const content = readTextFile(file)
        if (content === null) continue

        const lines = content.split('\n')
        for (let i = 0; i < lines.length; i++) {
            if (!pattern.test(lines[i])) continue
            // Test fixtures use obviously fake names on purpose.
            if (file.startsWith('tests/') && /someone|example|test/i.test(lines[i])) continue
            warn('personal-paths', 'personal absolute path in tracked file', `${file}:${i + 1}`)
            break
        }
    }
}

/**
 * Catches the trap where a directory is ignored but some of its files are
 * already tracked: new files there vanish silently.
 */
function checkIgnoredButTracked(files) {
    if (files.length === 0) return

    let ignored = ''
    try {
        // --no-index is essential: without it git skips tracked files, and a
        // tracked-but-ignored file is exactly what this check looks for.
        ignored = execFileSync('git', ['check-ignore', '--stdin', '--no-index'], {
            cwd: ROOT,
            input: files.join('\n'),
            encoding: 'utf-8'
        })
    } catch (error) {
        // Exit code 1 simply means nothing matched.
        ignored = error.status === 1 ? '' : ''
    }

    const conflicted = ignored.split('\n').filter(Boolean)
    if (conflicted.length === 0) return

    const directories = new Set(conflicted.map((f) => f.split('/').slice(0, 2).join('/')))
    fail(
        'ignored-but-tracked',
        `${conflicted.length} tracked file(s) are matched by .gitignore — new files beside them will be silently dropped`,
        [...directories].join(', ')
    )
}

/** Large binaries in a public repository are usually an accident. */
function checkLargeFiles(files) {
    const LIMIT = 5 * 1024 * 1024
    for (const file of files) {
        try {
            const { size } = statSync(join(ROOT, file))
            if (size > LIMIT) {
                warn('large-files', `${(size / 1024 / 1024).toFixed(1)}MB tracked file`, file)
            }
        } catch {
            // Deleted but still in the index; not this check's concern.
        }
    }
}

/** The release the world can download must be reproducible from the source. */
function checkReleaseCommitPushed() {
    let unpushed = ''
    try {
        unpushed = git(['log', '--oneline', '@{upstream}..HEAD'])
    } catch {
        warn('unpushed', 'no upstream configured for the current branch', 'git branch --set-upstream-to=origin/<branch>')
        return
    }

    const commits = unpushed.split('\n').filter(Boolean)
    if (commits.length === 0) return

    const release = commits.find((line) => /릴리즈|release|chore: v\d/i.test(line))
    if (release) {
        fail('unpushed', 'a release commit has not been pushed — the published build is not reproducible from source', release)
    } else {
        warn('unpushed', `${commits.length} commit(s) not pushed`, commits[0])
    }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const CHECKS = {
    secrets: checkSecrets,
    'personal-paths': checkPersonalPaths,
    'ignored-but-tracked': checkIgnoredButTracked,
    'large-files': checkLargeFiles,
    unpushed: checkReleaseCommitPushed
}

function main() {
    const args = process.argv.slice(2)

    if (args.includes('--list')) {
        console.log(Object.keys(CHECKS).join('\n'))
        return 0
    }

    const onlyArg = args.find((a) => a.startsWith('--only='))
    const selected = onlyArg ? onlyArg.slice('--only='.length).split(',') : Object.keys(CHECKS)

    const unknown = selected.filter((name) => !CHECKS[name])
    if (unknown.length > 0) {
        console.error(`Unknown check(s): ${unknown.join(', ')}`)
        console.error(`Available: ${Object.keys(CHECKS).join(', ')}`)
        return 1
    }

    const files = trackedFiles()
    console.log(`prepublish-check: ${files.length} tracked files, ${selected.length} check(s)\n`)

    for (const name of selected) {
        CHECKS[name](files)
    }

    for (const { check, message, detail } of warnings) {
        console.log(`  WARN  [${check}] ${message}${detail ? `\n          ${detail}` : ''}`)
    }
    for (const { check, message, detail } of failures) {
        console.log(`  FAIL  [${check}] ${message}${detail ? `\n          ${detail}` : ''}`)
    }

    console.log(
        `\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${failures.length} failure(s), ${warnings.length} warning(s)`
    )
    return failures.length === 0 ? 0 : 1
}

process.exit(main())
