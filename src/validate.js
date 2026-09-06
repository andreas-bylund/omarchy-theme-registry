#!/usr/bin/env node
// Validates theme submissions. Run with no arguments to check the whole registry,
// or pass the files a PR touched:
//
//   node src/validate.js themes/rustleaf.toml
//   node src/validate.js --report report.md themes/*.toml
//
// Exits non-zero on errors. Warnings and risk flags never fail the run — they are
// there for the human doing the merge.

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { builtinCollisionWarning, builtinThemes } from './lib/builtins.js'
import { declinedMessage, loadDenylist, normalizeRepo } from './lib/denylist.js'
import { githubRepo } from './lib/slug.js'
import { loadSubmissions, parseSubmission } from './lib/registry.js'
import { analyze, mapLimit } from './lib/process.js'
import { repoMeta } from './lib/github.js'
import { flagSeverity, renderStatusLine, renderVerdict, summarize } from './lib/verdict.js'

const CONCURRENCY = 6

async function main() {
  const argv = process.argv.slice(2)
  const reportIndex = argv.indexOf('--report')
  const reportFile = reportIndex === -1 ? null : argv[reportIndex + 1]
  const files = argv.filter(
    (a, i) => !a.startsWith('--') && !(reportIndex !== -1 && i === reportIndex + 1),
  )

  const { entries: submitted, errors: registryErrors, warnings: registryWarnings } = await collect(files)

  // Filtered before anything is cloned: a declined repo shouldn't come back with
  // a rendered palette and a tidy report, as if the only thing left were to
  // press merge.
  const { denied, errors: denylistErrors } = await loadDenylist('.')
  registryErrors.push(...denylistErrors)

  const entries = []
  for (const entry of submitted) {
    const decline = denied.get(normalizeRepo(entry.repo))
    if (decline) registryErrors.push(`${entry.file}: ${declinedMessage(decline)}`)
    else entries.push(entry)
  }

  const errors = [...registryErrors]

  const builtins = await builtinThemes()
  for (const entry of entries) {
    if (builtins.has(entry.slug)) {
      registryWarnings.push(`${entry.file}: ${builtinCollisionWarning(entry.slug)}`)
    }
  }

  if (!entries.length) {
    console.log(errors.length ? errors.join('\n') : 'Nothing to validate.')
    if (reportFile) await writeFile(reportFile, report([], errors, registryWarnings))
    process.exit(errors.length ? 1 : 0)
  }

  console.log(`Validating ${entries.length} theme${entries.length === 1 ? '' : 's'}…`)

  const results = await mapLimit(entries, CONCURRENCY, async (entry) => {
    const { sha, inspection } = await analyze(entry.repo, { slug: entry.slug })
    const gh = githubRepo(entry.repo)
    const meta = gh
      ? await repoMeta(gh.owner, gh.repo).catch((err) => {
          // Enrichment only — but say so, otherwise a rate-limited run silently
          // looks like "this repo has 0 stars and no license".
          console.warn(`  ! ${entry.slug}: GitHub metadata unavailable — ${err.message}`)
          return null
        })
      : null
    return { entry, sha, inspection, meta }
  })

  for (const { entry, inspection } of results) {
    for (const message of inspection.errors) errors.push(`${entry.file}: ${message}`)
  }

  const text = report(results, registryErrors, registryWarnings)
  console.log('\n' + text)
  if (reportFile) await writeFile(reportFile, text)

  process.exit(errors.length ? 1 : 0)
}

async function collect(files) {
  if (!files.length) return loadSubmissions('.')

  const entries = []
  const errors = []
  const warnings = []

  for (const file of files) {
    const rel = path.relative('.', file)
    if (!rel.startsWith('themes' + path.sep) || !rel.endsWith('.toml')) continue

    let text
    try {
      text = await readFile(rel, 'utf8')
    } catch {
      continue // deleted in this PR — nothing to validate
    }

    const result = parseSubmission(rel, text)
    errors.push(...result.errors)
    warnings.push(...result.warnings)
    if (result.entry) entries.push(result.entry)
  }

  return { entries, errors, warnings }
}

// Color chips via an external placeholder service, because GitHub strips inline
// SVG and data: URIs from comments. Swap the URL builder if you'd rather host it.
const chip = (hex, size = 26) => {
  const c = hex.replace('#', '')
  return `![${hex}](https://placehold.co/${size}x${size}/${c}/${c}.png)`
}

// GitHub issue-comment cap is 65536. A full card with palette chips is ~1.6k
// per theme; 50 of those blows the cap and the bot silently fails to post.
const GITHUB_COMMENT_MAX = 64_000
const FULL_CARD_LIMIT = 12

function report(results, registryErrors, registryWarnings = []) {
  const summary = summarize({ results, registryErrors })
  const compact = results.length > FULL_CARD_LIMIT

  const lines = ['## Theme validation', '', renderStatusLine(summary), '']

  if (registryErrors.length || registryWarnings.length) {
    lines.push('### Submission format', '')
    for (const e of registryErrors) lines.push(`- ❌ ${e}`)
    for (const w of registryWarnings) lines.push(`- ⚠️ ${w}`)
    lines.push('')
  }

  const sections = [
    [summary.failed, 'Failed — not a theme'],
    [summary.review, 'Needs a human glance'],
    [summary.clean, 'Clean'],
  ]

  for (const [group, title] of sections) {
    if (!group.length) continue
    lines.push(`### ${title}`, '')
    const expand = group === summary.clean && compact ? false : true
    if (!expand) {
      lines.push(
        '| Slug | Mode | Contrast | ★ | Notes |',
        '| --- | --- | ---: | ---: | --- |',
      )
      for (const row of group) lines.push(compactRow(row))
      lines.push('')
      continue
    }
    for (const row of group) lines.push(...themeCard(row))
  }

  lines.push(renderVerdict(summary))
  lines.push('', '_Rendered previews land on the registry site once merged._')

  let text = lines.join('\n')
  if (text.length > GITHUB_COMMENT_MAX) {
    // Last resort: drop palette chips so the verdict still lands.
    text = text
      .split('\n')
      .filter((line) => !line.includes('placehold.co'))
      .join('\n')
  }
  return text
}

function compactRow({ entry, inspection, meta }) {
  const notes = []
  if (!inspection.ok) notes.push('failed')
  else {
    if (inspection.flags?.length) notes.push(`${inspection.flags.length} flag(s)`)
    if (inspection.warnings?.length) notes.push(`${inspection.warnings.length} warning(s)`)
  }
  const mode = inspection.mode ?? '—'
  const contrast = inspection.contrast != null ? String(inspection.contrast) : '—'
  const stars = meta?.stars ?? '—'
  return `| \`${entry.slug}\` | ${mode} | ${contrast} | ${stars} | ${notes.join(', ') || '—'} |`
}

function themeCard({ entry, sha, inspection, meta }) {
  const lines = []
  const status = inspection.ok ? (inspection.warnings.length || inspection.flags.length ? '⚠️' : '✅') : '❌'
  lines.push(`#### ${status} \`${entry.slug}\``, '')
  lines.push(`**Repo:** ${entry.repo}`)
  if (sha) lines.push(`**Commit:** \`${sha.slice(0, 8)}\``)
  if (meta) {
    lines.push(`**Stars:** ${meta.stars} · **License:** ${meta.license ?? 'none detected'}`)
    if (meta.archived) lines.push('**Archived upstream** — consider whether it belongs in the registry.')
  } else {
    lines.push('_GitHub metadata unavailable for this run._')
  }
  lines.push('')

  if (!inspection.ok) {
    for (const e of inspection.errors) lines.push(`- ❌ ${e}`)
    lines.push('')
    return lines
  }

  lines.push(
    `Palette from \`${inspection.paletteSource}\` · **${inspection.mode}** · ` +
      `contrast ${inspection.contrast}:1 · ${inspection.backgrounds.length} wallpaper(s)`,
    '',
  )

  lines.push(
    [inspection.palette.background, inspection.palette.foreground, inspection.palette.accent]
      .map((c) => chip(c, 34))
      .join(' ') + '  ',
  )
  lines.push(
    Array.from({ length: 16 }, (_, i) => chip(inspection.palette[`color${i}`])).join(' '),
    '',
  )

  lines.push(
    inspection.overrides.length
      ? `**Hand-tuned overrides:** ${inspection.overrides.join(', ')}`
      : '**Hand-tuned overrides:** none — fully template-driven from the palette.',
    '',
  )

  for (const w of inspection.warnings) lines.push(`- ⚠️ ${w}`)

  if (inspection.flags.length) {
    const serious = inspection.flags.some((f) => flagSeverity(f) !== 'low')
    const summary = serious ? '🔍 Needs a human glance' : 'Benign notes (hyprlock clocks / test scripts)'
    lines.push('', `<details><summary>${summary}</summary>`, '')
    for (const { file, note, severity } of inspection.flags) {
      const tag = severity && severity !== 'medium' ? ` (${severity})` : ''
      lines.push(`- \`${file}\` ${note}${tag}`)
    }
    lines.push('', '</details>')
  }

  lines.push('')
  return lines
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
