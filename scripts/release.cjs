#!/usr/bin/env node
/**
 * Release orchestrator for macOS builds.
 *
 * Exists because a release has many preconditions that are invisible until they
 * fail, and the expensive step (a signed, notarized build) is the one that
 * surfaces them. On 2026-08-17 a build ran for minutes and then died at
 * notarization with "a required agreement is missing or has expired" — an
 * account-level problem that a single API call could have reported up front.
 *
 * So: everything cheap and everything checkable runs first, the build runs
 * second, and the artifacts are verified before anything is published.
 *
 * Usage:
 *   node scripts/release.cjs --check                 # preflight only, no changes
 *   node scripts/release.cjs --version 1.7.0         # full release
 *   node scripts/release.cjs --version 1.7.0 --notes path/to/notes.md
 *   node scripts/release.cjs --version 1.7.0 --skip-tests
 *
 * Nothing is published until every gate has passed. On a build failure the
 * output directory is removed, because a signed-but-unnotarized app sitting in
 * `release/` is the kind of artifact that gets uploaded by mistake.
 */

const { execFileSync, execSync } = require('child_process')
const { existsSync, readFileSync, writeFileSync, rmSync, readdirSync } = require('fs')
const { join } = require('path')

const ROOT = join(__dirname, '..')
const RELEASE_DIR = join(ROOT, 'release')

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

let failed = false

const log = (msg) => console.log(msg)
const pass = (name, detail) => log(`  PASS  ${name}${detail ? ` — ${detail}` : ''}`)
const warn = (name, detail) => log(`  WARN  ${name}${detail ? ` — ${detail}` : ''}`)

function fail(name, detail, fix) {
    failed = true
    log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
    if (fix) log(`        → ${fix}`)
}

function section(title) {
    log(`\n${title}`)
}

function run(cmd, args, options = {}) {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe', ...options })
}

/** Runs a command for its exit status only, never throwing. */
function tryRun(cmd, args, options = {}) {
    try {
        return { ok: true, out: run(cmd, args, options) }
    } catch (error) {
        return { ok: false, out: `${error.stdout ?? ''}${error.stderr ?? ''}`, status: error.status }
    }
}

// ---------------------------------------------------------------------------
// Preflight — ordered cheapest first so failures come back fast
// ---------------------------------------------------------------------------

function checkGitState() {
    section('Git')

    const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    if (branch === 'main') pass('on main', branch)
    else fail('not on main', branch, 'git checkout main')

    // Only package.json may be dirty: this script edits it itself.
    const dirty = run('git', ['status', '--porcelain'])
        .split('\n')
        .filter(Boolean)
        .filter((line) => !line.startsWith('??'))
        .filter((line) => !line.endsWith('package.json'))
    if (dirty.length === 0) pass('working tree clean')
    else fail('uncommitted changes', dirty.join(', '), 'commit or stash them first')

    tryRun('git', ['fetch', 'origin', '--tags', '--quiet'])

    const ahead = run('git', ['log', '--oneline', 'origin/main..HEAD']).split('\n').filter(Boolean)
    if (ahead.length === 0) pass('main is pushed')
    else
        fail(
            'unpushed commits',
            `${ahead.length}: ${ahead[0]}`,
            'git push origin main — a published build must be reproducible from source'
        )

    const behind = run('git', ['log', '--oneline', 'HEAD..origin/main']).split('\n').filter(Boolean)
    if (behind.length === 0) pass('main is up to date')
    else fail('local main is behind origin', `${behind.length} commit(s)`, 'git pull --ff-only')
}

function checkVersion(version) {
    section('Version')

    if (!/^\d+\.\d+\.\d+$/.test(version)) {
        fail('malformed version', version, 'use MAJOR.MINOR.PATCH')
        return
    }

    const current = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8')).version
    pass('current version', current)

    const tags = run('git', ['tag', '-l']).split('\n')
    if (tags.includes(`v${version}`)) {
        fail('tag already exists', `v${version}`, 'pick a new version — republishing replaces assets users already downloaded')
        return
    }

    const existing = tryRun('gh', ['release', 'view', `v${version}`, '--json', 'tagName'])
    if (existing.ok) fail('release already exists on GitHub', `v${version}`, 'pick a new version')
    else pass('version is unused', `v${version}`)
}

function checkToolchain() {
    section('Toolchain')

    for (const [tool, args] of [
        ['node', ['--version']],
        ['pnpm', ['--version']],
        ['gh', ['--version']]
    ]) {
        const result = tryRun(tool, args)
        if (result.ok) pass(tool, result.out.split('\n')[0].trim())
        else fail(`${tool} not available`, '', `install ${tool}`)
    }

    const auth = tryRun('gh', ['auth', 'status'])
    if (auth.ok) {
        const account = /Logged in to \S+ account (\S+)/.exec(auth.out)?.[1]
        pass('gh authenticated', account ?? '')
    } else {
        fail('gh not authenticated', '', 'gh auth login')
    }
}

function checkSigning() {
    section('Code signing')

    const identities = tryRun('security', ['find-identity', '-v', '-p', 'codesigning'])
    const match = /Developer ID Application: ([^"]+)\(([A-Z0-9]+)\)/.exec(identities.out ?? '')
    if (match) pass('Developer ID certificate', `${match[1].trim()} (${match[2]})`)
    else fail('no Developer ID certificate in keychain', '', 'import the signing certificate')

    for (const name of ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']) {
        if (process.env[name]) pass(name)
        else fail(`${name} is not set`, '', 'export it before releasing — the build signs and notarizes')
    }
}

/**
 * The check this script was written for.
 *
 * `notarytool history` is a read-only call that exercises the same credentials
 * and the same account agreements as the submission at the end of a build. If
 * it fails here, the build would have failed after several minutes of work.
 */
function checkNotarizationAccess() {
    section('Notarization access')

    const { APPLE_ID, APPLE_TEAM_ID, APPLE_APP_SPECIFIC_PASSWORD } = process.env
    if (!APPLE_ID || !APPLE_TEAM_ID || !APPLE_APP_SPECIFIC_PASSWORD) {
        fail('cannot check', 'Apple credentials missing', 'see above')
        return
    }

    const result = tryRun('xcrun', [
        'notarytool', 'history',
        '--apple-id', APPLE_ID,
        '--team-id', APPLE_TEAM_ID,
        '--password', APPLE_APP_SPECIFIC_PASSWORD
    ])

    // notarytool reports errors on stdout and still exits 0, so the output has
    // to be inspected rather than the exit status trusted.
    const output = result.out ?? ''

    if (/A required agreement is missing or has expired/.test(output)) {
        fail(
            'Apple agreement not in effect',
            'notarization returns HTTP 403',
            'accept the pending agreement at https://developer.apple.com/account (Account Holder), then re-run'
        )
        return
    }
    if (/HTTP status code: 401|Unable to authenticate/.test(output)) {
        fail('Apple credentials rejected', 'HTTP 401', 'regenerate the app-specific password at appleid.apple.com')
        return
    }
    if (/Error:/.test(output)) {
        fail('notarization service unavailable', output.split('\n')[0].trim(), 'resolve before building')
        return
    }

    pass('notarization reachable', 'agreements in effect')
}

function checkRepoHygiene() {
    section('Repository hygiene')
    const result = tryRun('node', [join(ROOT, 'scripts', 'prepublish-check.cjs')])
    if (result.ok) pass('prepublish-check')
    else fail('prepublish-check failed', '', 'node scripts/prepublish-check.cjs')
}

function checkBuildHealth({ skipTests }) {
    section('Build health')

    const typecheck = tryRun('pnpm', ['typecheck'])
    if (typecheck.ok) pass('typecheck')
    else fail('typecheck failed', '', 'pnpm typecheck')

    if (skipTests) {
        warn('tests skipped', '--skip-tests was passed')
        return
    }

    log('  ....  running tests (a few minutes)')
    const tests = tryRun('pnpm', ['test:term'], { stdio: 'pipe' })
    if (tests.ok) {
        const count = (tests.out.match(/✓/g) ?? []).length
        pass('tests', `${count} passed`)
    } else {
        fail('tests failed', '', 'pnpm test:term')
    }
}

// ---------------------------------------------------------------------------
// Build and verify
// ---------------------------------------------------------------------------

function setVersion(version) {
    const path = join(ROOT, 'package.json')
    const source = readFileSync(path, 'utf-8')
    const next = source.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`)
    writeFileSync(path, next)
}

/**
 * Builds, and removes the output directory if anything goes wrong.
 *
 * A failed notarization leaves a signed-but-unnotarized `.app` behind. Gatekeeper
 * rejects it on the user's machine, and it looks exactly like a good build in a
 * directory listing — so it must not survive the failure that produced it.
 */
function buildMac() {
    section('Build')
    rmSync(RELEASE_DIR, { recursive: true, force: true })

    try {
        execSync('pnpm build:mac', { cwd: ROOT, stdio: 'inherit' })
    } catch {
        log('\n  Build failed — removing release/ so a partial artifact cannot be published.')
        rmSync(RELEASE_DIR, { recursive: true, force: true })
        return false
    }
    return true
}

/**
 * Confirms the artifacts are actually publishable.
 *
 * electron-builder can exit 0 with an app that Gatekeeper will reject, so the
 * question "is this notarized" is asked of the artifact, not of the build log.
 */
function verifyArtifacts(version) {
    section('Artifact verification')

    if (!existsSync(RELEASE_DIR)) {
        fail('no release directory')
        return []
    }

    const files = readdirSync(RELEASE_DIR)
    const expected = [
        `cli-manager-${version}-arm64.dmg`,
        `cli-manager-${version}-x64.dmg`,
        `cli-manager-${version}-arm64.zip`,
        `cli-manager-${version}-x64.zip`,
        'latest-mac.yml'
    ]

    const missing = expected.filter((name) => !files.includes(name))
    if (missing.length === 0) pass('all artifacts present', `${expected.length} files`)
    else fail('missing artifacts', missing.join(', '))

    // latest-mac.yml is what the updater reads; a stale version here silently
    // breaks auto-update for everyone.
    const manifestPath = join(RELEASE_DIR, 'latest-mac.yml')
    if (existsSync(manifestPath)) {
        const manifest = readFileSync(manifestPath, 'utf-8')
        if (new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(manifest)) {
            pass('latest-mac.yml version', version)
        } else {
            fail('latest-mac.yml version mismatch', manifest.split('\n')[0])
        }
    }

    // The gate that matters: Gatekeeper's own verdict on the built app.
    const appPath = join(RELEASE_DIR, 'mac-arm64', 'CLI Manager.app')
    const fallbackApp = join(RELEASE_DIR, 'mac', 'CLI Manager.app')
    const target = existsSync(appPath) ? appPath : fallbackApp

    if (existsSync(target)) {
        const spctl = tryRun('spctl', ['-a', '-vvv', '-t', 'install', target])
        if (/source=Notarized Developer ID/.test(spctl.out ?? '')) {
            pass('notarized', 'Gatekeeper accepts the app')
        } else {
            fail(
                'app is not notarized',
                (spctl.out ?? '').split('\n').slice(0, 2).join(' ').trim(),
                'do not publish — users would hit a Gatekeeper block on first launch'
            )
        }

        const sign = tryRun('codesign', ['-dv', '--verbose=2', target])
        const team = /TeamIdentifier=(\S+)/.exec(sign.out ?? '')?.[1]
        if (team && team !== 'not set') pass('signed', `team ${team}`)
        else fail('app is not signed')
    } else {
        fail('built app not found', 'looked in mac-arm64/ and mac/')
    }

    return expected.filter((name) => files.includes(name)).map((name) => join(RELEASE_DIR, name))
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

function publish(version, assets, notesPath) {
    section('Publish')

    run('git', ['add', 'package.json'])
    run('git', ['commit', '-m', `chore: v${version} 릴리즈`])
    run('git', ['tag', `v${version}`])
    run('git', ['push', 'origin', 'main'])
    run('git', ['push', 'origin', `v${version}`])
    pass('pushed', `main + v${version}`)

    const args = ['release', 'create', `v${version}`, ...assets, '--title', `v${version}`]
    if (notesPath && existsSync(notesPath)) args.push('--notes-file', notesPath)
    else args.push('--generate-notes')

    run('gh', args, { stdio: 'inherit' })

    const url = run('gh', ['release', 'view', `v${version}`, '--json', 'url', '--jq', '.url']).trim()
    pass('release created', url)
    return url
}

/** The updater's real entry point, checked end to end after publishing. */
function verifyPublished(version) {
    section('Post-publish verification')

    const result = tryRun('curl', [
        '-sL',
        `https://github.com/woorichicken/CLI_manager/releases/latest/download/latest-mac.yml`
    ])
    if (!result.ok) {
        warn('could not fetch published manifest', 'check manually')
        return
    }
    if (new RegExp(`^version: ${version.replace(/\./g, '\\.')}$`, 'm').test(result.out)) {
        pass('updater manifest live', `version ${version}`)
    } else {
        fail('published manifest does not advertise this version', result.out.split('\n')[0])
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
    const args = process.argv.slice(2)
    const checkOnly = args.includes('--check')
    const skipTests = args.includes('--skip-tests')
    // indexOf returns -1 when absent, which would read args[0] as the version.
    const versionIndex = args.indexOf('--version')
    const version = versionIndex === -1 ? null : args[versionIndex + 1]
    const notesPath = args.includes('--notes') ? args[args.indexOf('--notes') + 1] : null

    if (!checkOnly && !version) {
        console.error('Usage: node scripts/release.cjs --version X.Y.Z [--notes file] [--skip-tests]')
        console.error('       node scripts/release.cjs --check')
        return 1
    }

    log(`CLI Manager release${checkOnly ? ' preflight' : ` — v${version}`}`)

    checkToolchain()
    checkGitState()
    if (version) checkVersion(version)
    checkSigning()
    checkNotarizationAccess()
    checkRepoHygiene()
    checkBuildHealth({ skipTests })

    if (failed) {
        log('\nPREFLIGHT FAILED — nothing was built or published.')
        return 1
    }
    log('\nPreflight passed.')

    if (checkOnly) return 0

    setVersion(version)
    if (!buildMac()) {
        run('git', ['checkout', 'package.json'])
        log('\nBUILD FAILED — version reverted, release/ removed, nothing published.')
        return 1
    }

    const assets = verifyArtifacts(version)
    if (failed) {
        run('git', ['checkout', 'package.json'])
        log('\nARTIFACT VERIFICATION FAILED — nothing published.')
        return 1
    }

    const url = publish(version, assets, notesPath)
    verifyPublished(version)

    log(`\n${failed ? 'PUBLISHED WITH WARNINGS' : 'DONE'} — ${url}`)
    log('Remaining manual steps: /solhun:changelog, /upload-to-r2, website download links.')
    return failed ? 1 : 0
}

process.exit(main())
