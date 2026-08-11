// Omarchy's own themes, which the registry needs to know about because a user
// theme sharing a builtin's slug does not replace it — omarchy-theme-set copies
// the official theme first and then overlays the user's files on top:
//
//   cp -r "$OMARCHY_THEMES_PATH/$THEME_NAME/"* "$NEXT_THEME_PATH/"
//   cp -r "$USER_THEMES_PATH/$THEME_NAME/"*    "$NEXT_THEME_PATH/"
//
// So the result is a silent merge of two themes, which is almost never what
// either author intended.

const SOURCE = 'https://api.github.com/repos/basecamp/omarchy/contents/themes'

// Fallback for offline runs. A stale list only costs us a missed warning, so it
// is not worth failing a build over — but the live fetch keeps it honest.
const FALLBACK = [
  'catppuccin',
  'catppuccin-latte',
  'ethereal',
  'everforest',
  'flexoki-light',
  'gruvbox',
  'hackerman',
  'kanagawa',
  'last-horizon',
  'lumon',
  'lupine',
  'matte-black',
  'miasma',
  'nord',
  'osaka-jade',
  'retro-82',
  'ristretto',
  'rose-pine',
  'solitude',
  'tokyo-night',
  'vantablack',
  'white',
]

let cached = null

export async function builtinThemes() {
  if (cached) return cached

  try {
    const headers = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'omarchy-theme-registry',
    }
    const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
    if (token) headers.Authorization = `Bearer ${token}`

    const res = await fetch(SOURCE, { headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)

    const entries = await res.json()
    const names = entries.filter((e) => e.type === 'dir').map((e) => e.name)
    if (!names.length) throw new Error('no directories in themes/')

    cached = new Set(names)
  } catch (err) {
    console.warn(`  ! could not read Omarchy's builtin themes (${err.message}) — using fallback list`)
    cached = new Set(FALLBACK)
  }

  return cached
}

export function builtinCollisionWarning(slug) {
  return (
    `"${slug}" is also the name of a builtin Omarchy theme. Installing this does not ` +
    `replace the builtin — omarchy-theme-set copies the official theme first and then ` +
    `overlays the user's files on top, silently merging the two. Whatever this theme ` +
    `doesn't ship is inherited from Omarchy's version.`
  )
}
