import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { shallowClone } from './git.js'
import { inspectTheme } from './inspect.js'
import { renderImage, renderMock } from './render.js'

/** Clone into a temp dir, run `fn(dir, sha)`, always clean up. */
export async function withClone(repo, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omarchy-theme-'))
  try {
    const sha = await shallowClone(repo, dir)
    return await fn(dir, sha)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/**
 * Clone a theme, inspect it, and (optionally) render its thumbnails — all inside
 * the clone's lifetime, since the wallpaper and screenshot sources disappear with
 * the temp directory.
 *
 * A dead or unclonable repo comes back shaped like a failed inspection so callers
 * can report it exactly the way they report a malformed one.
 */
export async function analyze(repo, { slug, thumbsDir = null } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omarchy-theme-'))

  try {
    const sha = await shallowClone(repo, dir)
    const inspection = await inspectTheme(dir)
    const thumbs = {}

    if (thumbsDir && inspection.ok) {
      await renderMock(inspection.palette, path.join(thumbsDir, `${slug}.webp`))
      thumbs.mock = `thumbs/${slug}.webp`

      if (inspection.backgrounds.length) {
        const out = path.join(thumbsDir, `${slug}-wall.webp`)
        const result = await renderImage(path.join(dir, inspection.backgrounds[0]), out)
        if (!result.error) thumbs.wallpaper = `thumbs/${slug}-wall.webp`
      }

      if (inspection.screenshot) {
        const out = path.join(thumbsDir, `${slug}-shot.webp`)
        const result = await renderImage(path.join(dir, inspection.screenshot), out, {
          width: 960,
          height: 600,
        })
        if (!result.error) thumbs.screenshot = `thumbs/${slug}-shot.webp`
      }
    }

    return { sha, inspection, thumbs }
  } catch (err) {
    return {
      sha: null,
      thumbs: {},
      inspection: {
        ok: false,
        errors: [`Could not clone or read ${repo}: ${err.message}`],
        warnings: [],
        files: [],
      },
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Bounded-concurrency map that preserves input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })

  await Promise.all(workers)
  return results
}
