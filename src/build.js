#!/usr/bin/env node
// Builds the published index from themes/*.toml.
//
//   node src/build.js --out dist --cache .cache
//
// Only themes whose upstream HEAD moved since the last build are re-cloned and
// re-rendered; everything else is reused from the cache. That keeps the nightly
// run cheap enough to grow to thousands of themes.

import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { builtinThemes } from './lib/builtins.js'
import { remoteHead } from './lib/git.js'
import { repoMeta } from './lib/github.js'
import { analyze, mapLimit } from './lib/process.js'
import { canonicalUrl, githubRepo } from './lib/slug.js'
import { loadSubmissions } from './lib/registry.js'

const INDEX_VERSION = 1

/**
 * Bump whenever thumbnails change appearance. Entries are otherwise cached on the
 * theme's upstream commit alone, so a renderer change leaves every unchanged
 * theme showing its old preview forever — which is exactly what happened when
 * previews became wallpaper composites.
 */
const RENDER_VERSION = 2

const CONCURRENCY = 6

async function main() {
  const argv = process.argv.slice(2)
  const outDir = argValue(argv, '--out') ?? 'dist'
  const cacheDir = argValue(argv, '--cache') ?? '.cache'
  const force = argv.includes('--force')

  const { entries, errors } = await loadSubmissions('.')
  if (errors.length) {
    console.error('Registry has invalid submissions:\n' + errors.map((e) => `  - ${e}`).join('\n'))
    process.exit(1)
  }

  const cached = await readCache(cacheDir)
  const builtins = await builtinThemes()
  const thumbsDir = path.join(outDir, 'thumbs')

  await rm(outDir, { recursive: true, force: true })
  await mkdir(thumbsDir, { recursive: true })

  console.log(`Building ${entries.length} themes (cache: ${cached.size} entries)…`)

  const stats = { reused: 0, rebuilt: 0, failed: 0 }

  const built = await mapLimit(entries, CONCURRENCY, async (entry) => {
    const gh = githubRepo(entry.repo)
    const meta = gh ? await repoMeta(gh.owner, gh.repo).catch(() => null) : null

    let sha = null
    try {
      sha = (await remoteHead(entry.repo)).sha
    } catch (err) {
      console.warn(`  ! ${entry.slug}: unreachable — ${err.message}`)
    }

    const previous = cached.get(entry.slug)
    if (!force && sha && previous?.commit === sha) {
      const restored = await restoreThumbs(previous, cacheDir, outDir)
      if (restored) {
        stats.reused++
        return { ...previous, ...fromSubmission(entry, builtins), ...fromMeta(meta) }
      }
    }

    if (!sha) {
      // Keep the last known-good entry rather than dropping a theme because the
      // host had a bad night.
      if (previous && (await restoreThumbs(previous, cacheDir, outDir))) {
        stats.reused++
        return { ...previous, unreachable: true }
      }
      stats.failed++
      return null
    }

    const { inspection, thumbs } = await analyze(entry.repo, { slug: entry.slug, thumbsDir })
    if (!inspection.ok) {
      console.warn(`  ! ${entry.slug}: ${inspection.errors.join(' ')}`)
      stats.failed++
      return null
    }

    stats.rebuilt++
    console.log(`  + ${entry.slug} (${inspection.mode}, ${inspection.overrides.length} overrides)`)

    return {
      ...fromSubmission(entry, builtins),
      commit: sha,
      palette: inspection.palette,
      palette_source: inspection.paletteSource,
      mode: inspection.mode,
      contrast: inspection.contrast,
      overrides: inspection.overrides,
      backgrounds: inspection.backgrounds.length,
      has_license: inspection.hasLicense,
      has_readme: inspection.hasReadme,
      flags: inspection.flags,
      warnings: inspection.warnings,
      thumb: thumbs.mock ?? null,
      thumb_composited: Boolean(thumbs.composited),
      wallpaper: thumbs.wallpaper ?? null,
      screenshot: thumbs.screenshot ?? null,
      ...fromMeta(meta),
    }
  })

  const themes = built.filter(Boolean).sort((a, b) => a.slug.localeCompare(b.slug))

  const index = {
    version: INDEX_VERSION,
    generated_at: new Date().toISOString(),
    count: themes.length,
    themes,
  }

  await writeFile(path.join(outDir, 'index.json'), JSON.stringify(index, null, 0) + '\n')
  await writeFile(path.join(outDir, 'index.pretty.json'), JSON.stringify(index, null, 2) + '\n')
  await saveCache(cacheDir, outDir, index)

  console.log(
    `\n${themes.length} themes indexed — ${stats.rebuilt} rebuilt, ${stats.reused} reused, ${stats.failed} failed.`,
  )
  if (stats.failed) console.log('Failed themes are omitted from the index; see warnings above.')
}

function fromSubmission(entry, builtins) {
  return {
    slug: entry.slug,
    name: prettyName(entry.slug),
    // Not a replacement: omarchy-theme-set overlays this theme's files on top of
    // Omarchy's own, so the two silently merge.
    shadows_builtin: builtins.has(entry.slug),
    repo: canonicalUrl(entry.repo),
    clone_url: entry.repo,
    install: `omarchy-theme-install ${entry.repo}`,
    tags: entry.tags,
    note: entry.note,
  }
}

function fromMeta(meta) {
  if (!meta) return { stars: 0, license: null, description: null, owner: null, archived: false, updated_at: null }
  return {
    stars: meta.stars,
    license: meta.license,
    description: meta.description,
    owner: meta.owner,
    owner_avatar: meta.owner_avatar,
    archived: meta.archived,
    updated_at: meta.pushed_at,
  }
}

/** Matches how omarchy-theme-list renders a slug for display. */
function prettyName(slug) {
  return slug.replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase()).replace(/-/g, ' ')
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag)
  return i === -1 ? null : argv[i + 1]
}

async function readCache(cacheDir) {
  try {
    const text = await readFile(path.join(cacheDir, 'index.json'), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed.version !== INDEX_VERSION) return new Map()
    if (parsed.render_version !== RENDER_VERSION) {
      console.log('Renderer changed since the last build — rebuilding every preview.')
      return new Map()
    }
    return new Map(parsed.themes.map((t) => [t.slug, t]))
  } catch {
    return new Map()
  }
}

/** Copy a cached theme's thumbnails into the output tree. */
async function restoreThumbs(entry, cacheDir, outDir) {
  const files = [entry.thumb, entry.wallpaper, entry.screenshot].filter(Boolean)
  if (!files.length) return true

  for (const rel of files) {
    const from = path.join(cacheDir, rel)
    try {
      await access(from)
    } catch {
      return false // cache lost the image — rebuild this theme
    }
    await cp(from, path.join(outDir, rel))
  }
  return true
}

async function saveCache(cacheDir, outDir, index) {
  await rm(cacheDir, { recursive: true, force: true })
  await mkdir(cacheDir, { recursive: true })
  await cp(path.join(outDir, 'thumbs'), path.join(cacheDir, 'thumbs'), { recursive: true })
  // render_version lives only in the cache — consumers key off `version`, and a
  // renderer bump is not a schema change.
  await writeFile(
    path.join(cacheDir, 'index.json'),
    JSON.stringify({ ...index, render_version: RENDER_VERSION }),
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
