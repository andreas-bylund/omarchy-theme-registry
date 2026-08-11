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

import { githubRepo } from './lib/slug.js'
import { loadSubmissions, parseSubmission } from './lib/registry.js'
import { analyze, mapLimit } from './lib/process.js'
import { repoMeta } from './lib/github.js'

const CONCURRENCY = 4

async function main() {
  const argv = process.argv.slice(2)
  const reportIndex = argv.indexOf('--report')
  const reportFile = reportIndex === -1 ? null : argv[reportIndex + 1]
  const files = argv.filter(
    (a, i) => !a.startsWith('--') && !(reportIndex !== -1 && i === reportIndex + 1),
  )

  const { entries, errors: registryErrors, warnings: registryWarnings } = await collect(files)
  const errors = [...registryErrors]

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

function report(results, registryErrors, registryWarnings = []) {
  const lines = ['## Theme validation', '']

  if (registryErrors.length || registryWarnings.length) {
    lines.push('### Submission format', '')
    for (const e of registryErrors) lines.push(`- ❌ ${e}`)
    for (const w of registryWarnings) lines.push(`- ⚠️ ${w}`)
    lines.push('')
  }

  for (const { entry, sha, inspection, meta } of results) {
    const status = inspection.ok ? (inspection.warnings.length ? '⚠️' : '✅') : '❌'
    lines.push(`### ${status} \`${entry.slug}\``, '')
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
      continue
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
      lines.push('', '<details><summary>🔍 Needs a human glance</summary>', '')
      for (const { file, note } of inspection.flags) lines.push(`- \`${file}\` ${note}`)
      lines.push('', '</details>')
    }

    lines.push('')
  }

  lines.push('---', '', '_Rendered previews land on the registry site once merged._')
  return lines.join('\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
