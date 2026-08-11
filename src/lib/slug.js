// Slug derivation, ported 1:1 from omarchy-theme-install so that a registry slug
// always equals the directory name the theme gets in ~/.config/omarchy/themes/.
//
//   REPO_PATH="${REPO_URL#*:}"   # only for scp-style SSH urls
//   basename "$REPO_PATH" .git | sed -E 's/^omarchy-//; s/-theme$//' | tr '[:upper:]' '[:lower:]'
//
// Note the sed runs before the lowercasing, so the prefix/suffix strip is
// case-sensitive. Keep it that way — mismatching upstream here would silently
// break the app's mapping from index entry to installed directory.

export function repoSlug(url) {
  let path = String(url).trim()

  // Strip user@host: from scp-style SSH URLs so the basename sees just the path.
  if (!path.includes('://') && /:.*\//.test(path)) {
    path = path.slice(path.indexOf(':') + 1)
  }

  const base = basename(path).replace(/\.git$/, '')
  return base.replace(/^omarchy-/, '').replace(/-theme$/, '').toLowerCase()
}

function basename(path) {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || ''
}

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/** @returns {{owner: string, repo: string} | null} */
export function githubRepo(url) {
  let s = String(url).trim()

  if (!s.includes('://') && /^[^/]+@[^/]+:/.test(s)) {
    // git@github.com:owner/repo.git
    const [host, path] = [s.slice(s.indexOf('@') + 1, s.indexOf(':')), s.slice(s.indexOf(':') + 1)]
    if (!GITHUB_HOSTS.has(host)) return null
    return splitPath(path)
  }

  let parsed
  try {
    parsed = new URL(s)
  } catch {
    return null
  }
  if (!GITHUB_HOSTS.has(parsed.hostname)) return null
  return splitPath(parsed.pathname)
}

function splitPath(path) {
  const parts = path.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (parts.length < 2) return null
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') }
}

/** Normalize any accepted URL form to a canonical https clone URL for display. */
export function canonicalUrl(url) {
  const gh = githubRepo(url)
  return gh ? `https://github.com/${gh.owner}/${gh.repo}` : String(url).trim().replace(/\.git$/, '')
}
