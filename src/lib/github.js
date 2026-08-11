const API = 'https://api.github.com'

function headers() {
  const h = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'omarchy-theme-registry',
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (token) h.Authorization = `Bearer ${token}`
  return h
}

// The search API resets its window every minute, so a short wait usually clears
// a 403. The core API can be an hour out, which is not worth blocking a build for.
const MAX_WAIT_MS = 90_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function api(path, { tolerate404 = false, retry = true } = {}) {
  const res = await fetch(`${API}${path}`, { headers: headers() })

  if (res.status === 404 && tolerate404) return null

  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000
    const waitMs = Number.isFinite(reset) ? reset - Date.now() + 1000 : 0

    if (retry && waitMs > 0 && waitMs <= MAX_WAIT_MS) {
      console.warn(`  … rate limited, waiting ${Math.ceil(waitMs / 1000)}s`)
      await sleep(waitMs)
      return api(path, { tolerate404, retry: false })
    }

    throw new Error(
      `github rate limited on ${path}` +
        (waitMs > 0 ? ` (resets in ${Math.ceil(waitMs / 1000)}s)` : '') +
        (process.env.GITHUB_TOKEN ? '' : ' — set GITHUB_TOKEN to raise the limit'),
    )
  }

  if (!res.ok) throw new Error(`github ${res.status} on ${path}`)
  return res.json()
}

/** Enrichment only — a theme on a non-GitHub host is still perfectly valid. */
export async function repoMeta(owner, repo) {
  const data = await api(`/repos/${owner}/${repo}`, { tolerate404: true })
  if (!data) return null

  return {
    description: data.description ?? null,
    stars: data.stargazers_count ?? 0,
    license: data.license?.spdx_id && data.license.spdx_id !== 'NOASSERTION' ? data.license.spdx_id : null,
    default_branch: data.default_branch ?? null,
    pushed_at: data.pushed_at ?? null,
    archived: Boolean(data.archived),
    owner: data.owner?.login ?? owner,
    owner_avatar: data.owner?.avatar_url ?? null,
    homepage: data.homepage || null,
  }
}

/** Paginated repository search, used by the crawler to seed the registry. */
export async function searchRepos(query, { maxPages = 10 } = {}) {
  const found = []

  for (let page = 1; page <= maxPages; page++) {
    const data = await api(
      `/search/repositories?q=${encodeURIComponent(query)}&per_page=100&page=${page}&sort=updated`,
    )
    found.push(...data.items)
    if (data.items.length < 100 || found.length >= data.total_count) break
  }

  return found
}
