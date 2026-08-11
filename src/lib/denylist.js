import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { parse as parseToml } from 'smol-toml'

export const DENYLIST_FILE = 'denied.toml'

const ALLOWED_KEYS = new Set(['repo', 'reason', 'declined'])

/**
 * Repos the registry has looked at and turned down.
 *
 * Dropping a theme from a crawl PR rejects it exactly once — the crawler only
 * knows what is on main, so the next run rediscovers it and proposes it again.
 * This file is where "we said no" is written down.
 */
export function normalizeRepo(url) {
  return String(url)
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
    .toLowerCase()
}

/** Returns `{ denied, errors }` — `denied` maps a normalized repo URL to its entry. */
export async function loadDenylist(root = '.') {
  const file = path.join(root, DENYLIST_FILE)
  const denied = new Map()
  const errors = []

  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (err) {
    // No denylist is the normal state of a young registry, not a failure.
    if (err.code === 'ENOENT') return { denied, errors }
    throw err
  }

  let data
  try {
    data = parseToml(text)
  } catch (err) {
    return { denied, errors: [`${DENYLIST_FILE}: not valid TOML — ${err.message}`] }
  }

  const rows = data.denied ?? []
  if (!Array.isArray(rows)) {
    return { denied, errors: [`${DENYLIST_FILE}: \`denied\` must be an array of [[denied]] tables.`] }
  }

  for (const [i, row] of rows.entries()) {
    const at = `${DENYLIST_FILE}: entry ${i + 1}`

    for (const key of Object.keys(row)) {
      if (!ALLOWED_KEYS.has(key)) {
        errors.push(`${at}: unknown key \`${key}\` (allowed: ${[...ALLOWED_KEYS].join(', ')})`)
      }
    }

    if (typeof row.repo !== 'string' || !row.repo.trim()) {
      errors.push(`${at}: \`repo\` is required and must be the repo URL that was declined.`)
      continue
    }

    // A denylist without reasons is just a wall of URLs nobody dares touch.
    if (typeof row.reason !== 'string' || !row.reason.trim()) {
      errors.push(`${at} (${row.repo}): \`reason\` is required — say why it was turned down.`)
    }

    const key = normalizeRepo(row.repo)
    if (denied.has(key)) {
      errors.push(`${at} (${row.repo}): listed twice.`)
      continue
    }

    denied.set(key, {
      repo: row.repo.trim(),
      reason: row.reason?.trim() ?? null,
      declined: row.declined ? String(row.declined).slice(0, 10) : null,
    })
  }

  return { denied, errors }
}

/** The message a submission pointing at a declined repo should fail with. */
export function declinedMessage(entry) {
  const when = entry.declined ? ` on ${entry.declined}` : ''
  return (
    `this repo is on the denylist (${DENYLIST_FILE}), declined${when}: ${entry.reason} ` +
    `If that call has changed, drop the entry from ${DENYLIST_FILE} in the same PR — ` +
    `the registry should not quietly re-accept something it turned down.`
  )
}
