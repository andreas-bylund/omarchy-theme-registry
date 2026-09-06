#!/usr/bin/env node
// Discovers Omarchy themes on GitHub and writes submission files for the ones the
// registry doesn't have yet.
//
//   node src/crawl.js              # dry run, prints what it found
//   node src/crawl.js --write      # writes themes/*.toml for new, valid themes
//   node src/crawl.js --write --limit 20
//
// Nobody opens a PR to an empty registry, so the bot seeds it and a human merges.
// Every candidate is cloned and inspected before it is written — the crawler
// proposes, it does not vouch.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'

import { builtinThemes } from './lib/builtins.js'
import { appendDenylist, loadDenylist, normalizeRepo } from './lib/denylist.js'
import { repoHasPalette, searchRepos } from './lib/github.js'
import { analyze, mapLimit } from './lib/process.js'
import { loadSubmissions, submissionToml, THEMES_DIR } from './lib/registry.js'
import { githubRepo, repoSlug } from './lib/slug.js'
import { looksLikeToolbelt, renderVerdict, summarize } from './lib/verdict.js'

const QUERIES = [
  'topic:omarchy-theme',
  'topic:omarchy-themes',
  'omarchy theme in:name',
]

const CONCURRENCY = 4

// Repos that match the search but are not themes.
const DENY = [/^omarchy$/i, /awesome-omarchy/i, /omarchy-themes?$/i, /omarchy-theme-registry/i]

async function main() {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const limit = Number(argValue(argv, '--limit') ?? 0) || Infinity

  const { entries } = await loadSubmissions('.')
  const known = new Set(entries.map((e) => e.slug))
  const knownRepos = new Set(entries.map((e) => e.repo.replace(/\.git$/, '').toLowerCase()))

  const { denied, errors: denylistErrors } = await loadDenylist('.')
  if (denylistErrors.length) {
    // A denylist that doesn't parse is worse than none: it silently stops
    // protecting, and the crawler would happily re-propose everything on it.
    console.error(denylistErrors.join('\n'))
    process.exit(1)
  }

  console.log(
    `Registry has ${known.size} themes` +
      (denied.size ? `, ${denied.size} declined` : '') +
      '. Searching…',
  )

  // A query that runs out of rate limit shouldn't throw away the ones that
  // already succeeded — a partial crawl still produces a useful PR.
  const seen = new Map()
  for (const query of QUERIES) {
    try {
      const repos = await searchRepos(query)
      console.log(`  ${query}: ${repos.length} repos`)
      for (const repo of repos) seen.set(repo.full_name.toLowerCase(), repo)
    } catch (err) {
      console.warn(`  ! ${query}: ${err.message}`)
    }
  }

  if (!seen.size) {
    console.error('Every search failed — refusing to report an empty crawl.')
    process.exit(1)
  }

  const candidates = []
  const skipped = { known: 0, filtered: 0, declined: 0, collision: 0 }
  const claimed = new Map() // slug -> the candidate holding it

  // Most-starred first, so a slug contested by two repos goes to the one people
  // actually use rather than to whichever the search happened to return first.
  const discovered = [...seen.values()].sort((a, b) => b.stargazers_count - a.stargazers_count)

  for (const repo of discovered) {
    if (DENY.some((re) => re.test(repo.name))) {
      skipped.filtered++
      continue
    }
    if (knownRepos.has(repo.html_url.toLowerCase())) {
      skipped.known++
      continue
    }

    const decline = denied.get(normalizeRepo(repo.html_url))
    if (decline) {
      console.log(`  ⊘ ${repo.full_name} — declined: ${decline.reason}`)
      skipped.declined++
      continue
    }

    const slug = repoSlug(repo.html_url)
    if (!slug) continue

    // Two repos deriving the same slug would clobber each other in
    // ~/.config/omarchy/themes — omarchy-theme-install rm -rf's the loser.
    if (known.has(slug)) {
      const holder = claimed.get(slug)
      console.log(
        `  ~ ${repo.full_name} wants slug "${slug}", already held by ` +
          (holder ? `${holder.full_name} (★${holder.stargazers_count})` : 'the registry'),
      )
      skipped.collision++
      continue
    }

    candidates.push({ slug, repo })
    known.add(slug)
    claimed.set(slug, repo)
  }

  console.log(
    `\n${candidates.length} candidates (${skipped.known} already indexed, ` +
      `${skipped.filtered} filtered, ${skipped.declined} declined, ` +
      `${skipped.collision} slug collisions)`,
  )

  const chosen = candidates.slice(0, limit === Infinity ? candidates.length : limit)
  const accepted = []
  const toolbelts = []
  const skippedNoPalette = []

  const checked = await mapLimit(chosen, CONCURRENCY, async ({ slug, repo }) => {
    const gh = githubRepo(repo.html_url)
    if (gh) {
      const hasPalette = await repoHasPalette(gh.owner, gh.repo).catch(() => true)
      if (!hasPalette) {
        return {
          slug,
          repo,
          inspection: {
            ok: false,
            errors: ['No colors.toml or alacritty.toml on GitHub — not cloned.'],
            warnings: [],
            flags: [],
          },
          probed: true,
        }
      }
    }
    const { inspection } = await analyze(repo.html_url, { slug })
    return { slug, repo, inspection }
  })

  for (const { slug, repo, inspection, probed } of checked) {
    if (!inspection.ok) {
      if (probed) skippedNoPalette.push({ slug, repo })
      console.log(`  ✗ ${slug} — ${inspection.errors.join(' ')}`)
      continue
    }
    if (looksLikeToolbelt(inspection)) {
      console.log(`  ⊘ ${slug} — toolbelt, not a theme (${inspection.flags.length} risk flags)`)
      toolbelts.push({ slug, repo, inspection })
      continue
    }
    console.log(
      `  ✓ ${slug} (${inspection.mode}, ${inspection.overrides.length} overrides` +
        `${inspection.flags.length ? `, ${inspection.flags.length} risk flags` : ''})`,
    )
    accepted.push({ slug, repo, inspection })
  }

  console.log(
    `\n${accepted.length} of ${chosen.length} candidates are valid themes` +
      (toolbelts.length ? `, ${toolbelts.length} toolbelt(s) refused` : '') +
      (skippedNoPalette.length ? `, ${skippedNoPalette.length} had no palette` : '') +
      '.',
  )

  const builtins = await builtinThemes()
  const report = crawlReport({ accepted, toolbelts, skippedNoPalette, builtins })

  if (!write) {
    console.log('\n' + report)
    console.log('Dry run — pass --write to create submission files.')
    return
  }

  for (const { slug, repo, inspection } of accepted) {
    const tags = [inspection.mode]
    if (inspection.flags.length) tags.push('needs-review')
    if (builtins.has(slug)) tags.push('shadows-builtin')

    await writeFile(
      path.join(THEMES_DIR, `${slug}.toml`),
      submissionToml({ repo: repo.html_url, tags }),
    )
  }

  if (toolbelts.length) {
    await appendDenylist(
      '.',
      toolbelts.map(({ repo, inspection }) => ({
        repo: repo.html_url,
        reason:
          `Crawler refused: looks like a toolbelt, not a theme ` +
          `(${inspection.flags.length} risk flag(s)` +
          (inspection.flags.some((f) => /suspicious filename/i.test(f.note))
            ? ', suspicious filenames'
            : '') +
          '). Remove this entry to reconsider.',
      })),
    )
  }

  // Consumed by the workflow to build the PR body.
  await writeFile('crawl-report.md', report)

  console.log(
    `Wrote ${accepted.length} submission file(s)` +
      (toolbelts.length ? `, denied ${toolbelts.length} toolbelt(s)` : '') +
      ' + crawl-report.md',
  )
}

function asVerdictResult({ slug, repo, inspection }) {
  return {
    entry: { slug, repo: repo.html_url },
    inspection,
    meta: {
      stars: repo.stargazers_count ?? 0,
      archived: Boolean(repo.archived),
      license: repo.license?.spdx_id ?? null,
    },
  }
}

function crawlReport({ accepted, toolbelts, skippedNoPalette, builtins }) {
  const summary = summarize({ results: accepted.map(asVerdictResult) })
  const lines = []

  lines.push(
    `Found **${accepted.length}** new theme${accepted.length === 1 ? '' : 's'}` +
      (summary.counts.review ? ` — **${summary.counts.review}** need a glance` : '') +
      (toolbelts.length ? ` · ${toolbelts.length} toolbelt(s) sent to \`denied.toml\`` : '') +
      '.',
    '',
  )

  const bullet = (result) => {
    const { entry, inspection, meta } = result
    const notes = []
    if (inspection.flags.length) {
      const high = inspection.flags.filter((f) => f.severity === 'high').length
      const medium = inspection.flags.filter((f) => f.severity === 'medium').length
      notes.push(
        `🔍 ${inspection.flags.length} risk flag(s)` +
          (high || medium ? ` (${high} high, ${medium} medium)` : ''),
      )
    }
    if (builtins.has(entry.slug)) notes.push('⚠️ shadows a builtin Omarchy theme')
    return (
      `- **${entry.slug}** — ${entry.repo} (${inspection.mode}, ★${meta.stars})` +
      (notes.length ? ` — ${notes.join(', ')}` : '')
    )
  }

  if (summary.review.length) {
    lines.push(`### Needs a human glance (${summary.review.length})`, '')
    lines.push(...summary.review.map(bullet), '')
  }
  if (summary.clean.length) {
    lines.push(`### Clean (${summary.clean.length})`, '')
    lines.push(...summary.clean.map(bullet), '')
  }

  if (toolbelts.length) {
    lines.push(`### Refused as not-a-theme (${toolbelts.length})`, '')
    lines.push(
      'These cloned and had a palette, but they look like a toolbelt wearing a theme\'s clothes. ' +
        'They are appended to `denied.toml` in this PR rather than `themes/` — drop the denylist ' +
        'entry if that call is wrong.',
      '',
    )
    for (const { slug, repo, inspection } of toolbelts) {
      lines.push(
        `- **${slug}** — ${repo.html_url} (${inspection.flags.length} risk flags)`,
      )
    }
    lines.push('')
  }

  if (skippedNoPalette.length) {
    lines.push(
      `<details><summary>${skippedNoPalette.length} candidate(s) skipped — no palette file on GitHub</summary>`,
      '',
      ...skippedNoPalette.map(({ slug, repo }) => `- ${slug} — ${repo.html_url}`),
      '',
      '</details>',
      '',
    )
  }

  lines.push(
    'Every `themes/` entry was cloned and validated before being added. The crawler proposes; ' +
      'it does not vouch. Reject anything that looks off.',
    '',
  )
  lines.push(renderVerdict(summary))
  return lines.join('\n')
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
