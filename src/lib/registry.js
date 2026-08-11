import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { parse as parseToml } from 'smol-toml'

import { repoSlug } from './slug.js'

export const THEMES_DIR = 'themes'

const ALLOWED_KEYS = new Set(['repo', 'tags', 'note'])
const URL_FORMS = [/^https:\/\/\S+$/, /^ssh:\/\/\S+$/, /^git@[^:]+:\S+\/\S+$/]

/** Parse and validate one submission file. Returns `{ entry, errors }`. */
export function parseSubmission(file, text) {
  const errors = []
  const warnings = []
  const slug = path.basename(file, '.toml')
  let data

  try {
    data = parseToml(text)
  } catch (err) {
    return { entry: null, errors: [`${file}: not valid TOML — ${err.message}`], warnings }
  }

  for (const key of Object.keys(data)) {
    if (!ALLOWED_KEYS.has(key)) {
      errors.push(`${file}: unknown key \`${key}\` (allowed: ${[...ALLOWED_KEYS].join(', ')})`)
    }
  }

  const repo = data.repo
  if (typeof repo !== 'string' || !repo.trim()) {
    errors.push(`${file}: \`repo\` is required and must be a git URL string.`)
    return { entry: null, errors, warnings }
  }
  if (!URL_FORMS.some((re) => re.test(repo.trim()))) {
    errors.push(
      `${file}: \`repo\` must be https://, ssh:// or git@host:owner/repo — got "${repo}".`,
    )
  }

  const derived = repoSlug(repo)
  if (derived !== slug) {
    errors.push(
      `${file}: filename must match the slug Omarchy derives from the repo URL. ` +
        `omarchy-theme-install would install this as "${derived}", so the file has to be ` +
        `themes/${derived}.toml. Rename the file (or the repo) so the registry slug and the ` +
        `installed directory name agree.`,
    )
  }

  // Omarchy's prefix/suffix strip runs before the lowercasing, so it is
  // case-sensitive: "Omarchy-Foo-Theme" keeps both, and installs into a
  // directory literally named "omarchy-foo-theme". Faithful, but ugly — and the
  // author is the only one who can fix it.
  const lowered = repoSlug(repo.toLowerCase())
  if (derived === slug && lowered !== derived) {
    warnings.push(
      `${file}: this repo's name is capitalized, and Omarchy's "omarchy-" / "-theme" strip is ` +
        `case-sensitive — so it installs as "${derived}" instead of "${lowered}". ` +
        `Renaming the repo to all-lowercase would give it the cleaner slug.`,
    )
  }

  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags) || data.tags.some((t) => typeof t !== 'string')) {
      errors.push(`${file}: \`tags\` must be an array of strings.`)
    } else if (data.tags.length > 8) {
      errors.push(`${file}: at most 8 tags.`)
    }
  }

  if (data.note !== undefined && typeof data.note !== 'string') {
    errors.push(`${file}: \`note\` must be a string.`)
  }

  return {
    entry: {
      slug,
      file,
      repo: repo.trim(),
      tags: (data.tags ?? []).map((t) => t.toLowerCase()),
      note: data.note ?? null,
    },
    errors,
    warnings,
  }
}

export async function loadSubmissions(root = '.') {
  const dir = path.join(root, THEMES_DIR)
  const names = (await readdir(dir)).filter((f) => f.endsWith('.toml')).sort()
  const entries = []
  const errors = []
  const warnings = []

  for (const name of names) {
    const file = path.join(THEMES_DIR, name)
    const text = await readFile(path.join(root, THEMES_DIR, name), 'utf8')
    const result = parseSubmission(file, text)
    errors.push(...result.errors)
    warnings.push(...result.warnings)
    if (result.entry) entries.push(result.entry)
  }

  // The filename is the slug, so the filesystem already guarantees uniqueness —
  // but two files can still point at the same repo.
  const byRepo = new Map()
  for (const entry of entries) {
    const key = entry.repo.replace(/\.git$/, '').toLowerCase()
    if (byRepo.has(key)) {
      errors.push(`${entry.file}: duplicate of ${byRepo.get(key)} — same repo, two entries.`)
    } else {
      byRepo.set(key, entry.file)
    }
  }

  return { entries, errors, warnings }
}

export function submissionToml({ repo, tags = [], note = null }) {
  const lines = [`repo = "${repo}"`]
  if (tags.length) lines.push(`tags = [${tags.map((t) => `"${t}"`).join(', ')}]`)
  if (note) lines.push(`note = "${note.replace(/"/g, "'")}"`)
  return lines.join('\n') + '\n'
}
