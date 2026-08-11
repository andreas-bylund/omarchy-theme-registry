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
import { searchRepos } from './lib/github.js'
import { analyze, mapLimit } from './lib/process.js'
import { loadSubmissions, submissionToml, THEMES_DIR } from './lib/registry.js'
import { repoSlug } from './lib/slug.js'

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

  console.log(`Registry has ${known.size} themes. Searching…`)

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
  const skipped = { known: 0, denied: 0, collision: 0 }
  const claimed = new Map() // slug -> the candidate holding it

  // Most-starred first, so a slug contested by two repos goes to the one people
  // actually use rather than to whichever the search happened to return first.
  const discovered = [...seen.values()].sort((a, b) => b.stargazers_count - a.stargazers_count)

  for (const repo of discovered) {
    if (DENY.some((re) => re.test(repo.name))) {
      skipped.denied++
      continue
    }
    if (knownRepos.has(repo.html_url.toLowerCase())) {
      skipped.known++
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
      `${skipped.denied} filtered, ${skipped.collision} slug collisions)`,
  )

  const chosen = candidates.slice(0, limit === Infinity ? candidates.length : limit)
  const accepted = []

  const checked = await mapLimit(chosen, CONCURRENCY, async ({ slug, repo }) => {
    const { inspection } = await analyze(repo.html_url, { slug })
    return { slug, repo, inspection }
  })

  for (const { slug, repo, inspection } of checked) {
    if (!inspection.ok) {
      console.log(`  ✗ ${slug} — ${inspection.errors.join(' ')}`)
      continue
    }
    console.log(
      `  ✓ ${slug} (${inspection.mode}, ${inspection.overrides.length} overrides` +
        `${inspection.flags.length ? `, ${inspection.flags.length} risk flags` : ''})`,
    )
    accepted.push({ slug, repo, inspection })
  }

  console.log(`\n${accepted.length} of ${chosen.length} candidates are valid themes.`)

  if (!write) {
    console.log('Dry run — pass --write to create submission files.')
    return
  }

  const builtins = await builtinThemes()

  for (const { slug, repo, inspection } of accepted) {
    const tags = [inspection.mode]
    if (inspection.flags.length) tags.push('needs-review')
    if (builtins.has(slug)) tags.push('shadows-builtin')

    await writeFile(
      path.join(THEMES_DIR, `${slug}.toml`),
      submissionToml({ repo: repo.html_url, tags }),
    )
  }

  // Consumed by the workflow to build the PR body.
  await writeFile(
    'crawl-report.md',
    [
      `Found ${accepted.length} new theme${accepted.length === 1 ? '' : 's'}.`,
      '',
      ...accepted.map(({ slug, repo, inspection }) => {
        const notes = []
        if (inspection.flags.length) notes.push(`🔍 ${inspection.flags.length} risk flag(s)`)
        if (builtins.has(slug)) notes.push('⚠️ shadows a builtin Omarchy theme')
        return (
          `- **${slug}** — ${repo.html_url} (${inspection.mode}, ★${repo.stargazers_count})` +
          (notes.length ? ` — ${notes.join(', ')}` : '')
        )
      }),
      '',
      'Every entry was cloned and validated before being added. Reject anything that',
      'looks off — the crawler only proposes.',
    ].join('\n'),
  )

  console.log(`Wrote ${accepted.length} submission files + crawl-report.md`)
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
