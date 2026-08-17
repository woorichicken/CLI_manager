---
name: upload-to-r2
description: Upload CLI Manager release DMG files to Cloudflare R2. Use when the user asks to upload a release to R2, publish DMG files, or refresh the website download links. Normally invoked through scripts/post-release.cjs rather than directly.
---

# Upload to R2

Uploads `release/cli-manager-{version}-{arm64,x64}.dmg` to the Cloudflare R2 bucket that
solhun.com links to.

## Prefer post-release.cjs

This script is the upload step only. In a real release it should be reached through:

```bash
DATABASE_URL=... node scripts/post-release.cjs --version X.Y.Z --notes changelog.json
```

That wrapper does what this script cannot: it verifies the **public** URL serves the file at the
right size before the website is rewritten to point at it, and it leaves the site on the previous
release if that check fails. Running this script alone uploads without ever confirming the result is
reachable.

## Direct use

```bash
node .claude/skills/upload-to-r2/scripts/upload-to-r2.js          # version from package.json
node .claude/skills/upload-to-r2/scripts/upload-to-r2.js 1.7.0    # explicit version
```

Both DMG files must already exist in `release/`; the script refuses to run otherwise.

## Credentials

Read from the environment: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`R2_BUCKET_NAME`.

On the maintainer's machine these live in `.env.release` at the repository root, which is
gitignored and loaded automatically by `post-release.cjs`. They are deliberately **not** in this
file or in the script — this repository is public.

A fresh clone therefore gets a script that asks for credentials it does not have, which is the
correct behaviour for someone else's bucket.
