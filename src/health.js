#!/usr/bin/env node
// Re-checks themes already in the registry: are the repos still there, and
// (when upstream HEAD moved) are they still themes?
//
//   node src/health.js                 # report only
//   node src/health.js --write         # drop gone/broken submissions
//   node src/health.js --inspect-all   # re-clone every theme, not just SHA changes
//
// Existence is cheap (`git ls-remote` + GitHub 404). Re-inspecting is reserved
// for commits we haven't seen, so a 300-theme registry doesn't get fully cloned
// every night. A deleted GitHub repo is a 404 and comes off the registry; a
// flaky host is "unreachable" and stays, same as the nightly build.

import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { appendDenylist } from './lib/denylist.js'
import { remoteHead } from './lib/git.js'
import { repoMeta } from './lib/github.js'
import { analyze, mapLimit } from './lib/process.js'
import { loadSubmissions } from './lib/registry.js'
import { githubRepo } from './lib/slug.js'
import { looksLikeToolbelt } from './lib/verdict.js'

const CONCURRENCY = 8
const CACHE_FILE = path.join('.cache', 'health.json')
const NON_GITHUB_GONE_STREAK = 3

// A GitHub outage that 404s everything should not empty the registry. If more
// than this share look gone, --write refuses and the report says so.
const WRITE_RAIL = { fraction: 0.15, min: 10 }

async function main() {
  const argv = process.argv.slice(2)
  const write = argv.includes('--write')
  const inspectAll = argv.includes('--inspect-all')
  const limit = Number(argValue(argv, '--limit') ?? 0) || Infinity

  const { entries: allEntries, errors } = await loadSubmissions('.')
  if (errors.length) {
    console.error('Registry has invalid submissions:\n' + errors.map((e) => `  - ${e}`).join('\n'))
    process.exit(1)
  }

  const entries = allEntries.slice(0, limit === Infinity ? allEntries.length : limit)

  const cache = await readCache()
  const inspectChanged = inspectAll || cache.themes.size > 0

  console.log(
    `Health-checking ${entries.length} theme${entries.length === 1 ? '' : 's'}` +
      (inspectAll ? ' (re-inspecting every clone)' : inspectChanged ? ' (inspecting SHA changes)' : ' (existence only)') +
      '…',
  )

  const reports = await mapLimit(entries, CONCURRENCY, (entry) =>
    checkOne(entry, cache.themes.get(entry.slug), { inspectAll, inspectChanged }),
  )

  const known = new Set(allEntries.map((e) => e.slug))
  const nextCache = {
    updated_at: new Date().toISOString(),
    themes: Object.fromEntries([...cache.themes].filter(([slug]) => known.has(slug))),
  }
  for (const row of reports) {
    nextCache.themes[row.entry.slug] = {
      sha: row.sha,
      status: row.status,
      unreachable_streak: row.unreachable_streak ?? 0,
    }
  }

  const buckets = {
    ok: reports.filter((r) => r.status === 'ok'),
    gone: reports.filter((r) => r.status === 'gone'),
    broken: reports.filter((r) => r.status === 'broken'),
    unreachable: reports.filter((r) => r.status === 'unreachable'),
    archived: reports.filter((r) => r.meta?.archived && r.status !== 'gone'),
  }

  const report = healthReport(buckets, entries.length)
  console.log('\n' + report)
  await writeFile('health-report.md', report)
  await saveCache(nextCache)

  const drop = [...buckets.gone, ...buckets.broken]
  if (!write) {
    if (drop.length) console.log('Dry run — pass --write to drop gone/broken submissions.')
    return
  }

  if (!drop.length) {
    console.log('Nothing to drop.')
    return
  }

  if (tripsRail(drop.length, entries.length)) {
    console.error(
      `--write refused: ${drop.length} of ${entries.length} themes look gone/broken ` +
        `(rail is ${Math.round(WRITE_RAIL.fraction * 100)}% or ${WRITE_RAIL.min}, whichever is higher). ` +
        `This looks like an outage, not a mass deletion.`,
    )
    process.exit(2)
  }

  for (const row of buckets.gone) {
    await unlink(row.entry.file)
    console.log(`  - removed ${row.entry.file} (repo gone)`)
  }

  if (buckets.broken.length) {
    await appendDenylist(
      '.',
      buckets.broken.map((row) => ({
        repo: row.entry.repo,
        reason:
          `No longer a valid Omarchy theme: ${(row.errors ?? ['inspection failed']).join('; ')}. ` +
          `Remove this entry to reconsider.`,
      })),
    )
    for (const row of buckets.broken) {
      await unlink(row.entry.file)
      console.log(`  - removed ${row.entry.file} (no longer a theme) + denied`)
    }
  }

  console.log(`Dropped ${drop.length} submission(s).`)
}

async function checkOne(entry, previous, { inspectAll, inspectChanged }) {
  const gh = githubRepo(entry.repo)
  const ghStatus = gh ? await githubPresence(gh) : { exists: null, meta: null, error: null }
  const meta = ghStatus.meta

  // 404 is gone. A throw (rate limit, 5xx) is an outage — do not drop the theme.
  if (gh && ghStatus.exists === false) {
    console.log(`  ✗ ${entry.slug} — gone (GitHub 404)`)
    return { entry, status: 'gone', sha: null, meta: null, errors: ['GitHub repo returned 404'] }
  }

  let sha = null
  try {
    sha = (await remoteHead(entry.repo)).sha
  } catch (err) {
    const streak = (previous?.unreachable_streak ?? 0) + 1
    if (!gh && streak >= NON_GITHUB_GONE_STREAK) {
      console.log(`  ✗ ${entry.slug} — gone (unreachable ${streak} runs in a row)`)
      return {
        entry,
        status: 'gone',
        sha: null,
        meta,
        unreachable_streak: streak,
        errors: [`unreachable ${streak} consecutive runs: ${err.message}`],
      }
    }
    console.log(`  ~ ${entry.slug} — unreachable (${err.message})`)
    return { entry, status: 'unreachable', sha: null, meta, unreachable_streak: streak }
  }

  const shouldInspect =
    inspectAll || (inspectChanged && previous?.sha && previous.sha !== sha)

  if (shouldInspect) {
    const { inspection } = await analyze(entry.repo, { slug: entry.slug })
    if (!inspection.ok) {
      console.log(`  ✗ ${entry.slug} — no longer a theme: ${inspection.errors.join(' ')}`)
      return { entry, status: 'broken', sha, meta, errors: inspection.errors, inspection }
    }
    if (looksLikeToolbelt(inspection)) {
      console.log(`  ✗ ${entry.slug} — became a toolbelt (${inspection.flags.length} flags)`)
      return {
        entry,
        status: 'broken',
        sha,
        meta,
        errors: ['repo now looks like a toolbelt, not a theme'],
        inspection,
      }
    }
    console.log(`  + ${entry.slug} — re-inspected, still a theme`)
    return { entry, status: 'ok', sha, meta, inspection }
  }

  return { entry, status: 'ok', sha, meta, unreachable_streak: 0 }
}

async function githubPresence(gh) {
  try {
    const meta = await repoMeta(gh.owner, gh.repo)
    return { exists: meta !== null, meta, error: null }
  } catch (err) {
    return { exists: null, meta: null, error: err }
  }
}

function tripsRail(dropCount, total) {
  const rail = Math.max(WRITE_RAIL.min, Math.ceil(total * WRITE_RAIL.fraction))
  return dropCount > rail
}

function healthReport(buckets, total) {
  const drop = buckets.gone.length + buckets.broken.length
  const lines = ['## Registry health', '']

  lines.push(
    '| | Count |',
    '| --- | ---: |',
    `| Indexed | ${total} |`,
    `| Still there | ${buckets.ok.length} |`,
    `| Gone | ${buckets.gone.length} |`,
    `| No longer a theme | ${buckets.broken.length} |`,
    `| Unreachable (kept) | ${buckets.unreachable.length} |`,
    `| Archived upstream | ${buckets.archived.length} |`,
    '',
  )

  if (!drop && !buckets.unreachable.length) {
    lines.push('### ✅ All indexed themes still exist', '')
    lines.push('Every submission points at a repo that resolved this run. Nothing to drop.')
  } else if (!drop) {
    lines.push('### ⚠️ Some hosts had a bad night — nothing dropped', '')
    lines.push(
      'Unreachable is not the same as gone. The last known-good index entry stays published, ' +
        'same as the nightly build. A GitHub 404 is required before a theme comes off the registry.',
    )
  } else {
    lines.push('### ❌ Drop these from the registry', '')
    lines.push(
      'Gone repos 404 on GitHub (or a non-GitHub host has failed for ' +
        `${NON_GITHUB_GONE_STREAK} consecutive runs). ` +
        'Broken repos still clone but no longer parse as an Omarchy theme. ' +
        'The crawler will not re-propose a broken repo because it is added to `denied.toml`.',
      '',
    )
  }

  if (buckets.gone.length) {
    lines.push('#### Gone', '')
    for (const row of buckets.gone) {
      lines.push(`- \`${row.entry.slug}\` — ${row.entry.repo} — ${(row.errors ?? ['gone']).join('; ')}`)
    }
    lines.push('')
  }
  if (buckets.broken.length) {
    lines.push('#### No longer a theme', '')
    for (const row of buckets.broken) {
      lines.push(`- \`${row.entry.slug}\` — ${row.entry.repo} — ${(row.errors ?? ['broken']).join('; ')}`)
    }
    lines.push('')
  }
  if (buckets.unreachable.length) {
    lines.push('<details><summary>Unreachable this run (kept)</summary>', '')
    for (const row of buckets.unreachable) {
      lines.push(`- \`${row.entry.slug}\` — ${row.entry.repo}`)
    }
    lines.push('', '</details>', '')
  }

  if (drop) {
    if (tripsRail(drop, total)) {
      lines.push(
        `**Write rail tripped:** ${drop} of ${total} is over the safety rail ` +
          `(${Math.round(WRITE_RAIL.fraction * 100)}% / min ${WRITE_RAIL.min}). ` +
          '`--write` will refuse rather than empty the registry on an outage.',
        '',
      )
    } else {
      lines.push(
        `Safe to merge this health PR: it only removes repos that are gone or no longer themes, ` +
          `and ${drop} of ${total} is under the safety rail.`,
        '',
      )
    }
  }

  return lines.join('\n')
}

async function readCache() {
  try {
    const parsed = JSON.parse(await readFile(CACHE_FILE, 'utf8'))
    return { themes: new Map(Object.entries(parsed.themes ?? {})) }
  } catch {
    return { themes: new Map() }
  }
}

async function saveCache(state) {
  await mkdir(path.dirname(CACHE_FILE), { recursive: true })
  await writeFile(CACHE_FILE, JSON.stringify(state, null, 2) + '\n')
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
