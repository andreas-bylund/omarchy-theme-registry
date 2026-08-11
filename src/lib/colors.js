// Palette extraction. Mirrors omarchy-theme-colors-from-alacritty so the registry
// reports the same colors Omarchy will actually generate its templates from.

const HEX6 = /^[0-9a-fA-F]{6}$/

export const NORMAL_NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white']

export function normalizeHex(value) {
  if (value == null) return null
  let c = String(value).trim()
  c = c.replace(/^["']/, '').replace(/["']$/, '').trim()
  c = c.replace(/^0[xX]/, '').replace(/^#/, '')
  return HEX6.test(c) ? '#' + c.toLowerCase() : null
}

/** Strip a `#` comment, respecting single and double quotes. */
function stripComment(line) {
  let out = ''
  let inSingle = false
  let inDouble = false
  let prev = ''

  for (const ch of line) {
    if (ch === '"' && !inSingle && prev !== '\\') inDouble = !inDouble
    else if (ch === "'" && !inDouble) inSingle = !inSingle

    if (ch === '#' && !inSingle && !inDouble) break

    out += ch
    prev = ch
  }
  return out.trimEnd()
}

/**
 * Parse a TOML-ish file into `section -> key -> raw value`. Deliberately tolerant:
 * theme repos are hand-written and a strict parser would reject files Omarchy
 * itself happily reads. Top-level keys live under the '' section.
 */
export function parseSections(text) {
  const sections = new Map([['', new Map()]])
  let current = ''

  for (const raw of String(text).split(/\r?\n/)) {
    const header = raw.match(/^\s*\[([^\]]+)\]\s*$/)
    if (header) {
      current = header[1].trim()
      if (!sections.has(current)) sections.set(current, new Map())
      continue
    }

    const line = stripComment(raw)
    const eq = line.indexOf('=')
    if (eq === -1) continue

    const key = line.slice(0, eq).trim().replace(/^["']|["']$/g, '')
    const value = line.slice(eq + 1).trim()
    if (!key) continue
    sections.get(current).set(key, value)
  }

  return sections
}

/** Look up `[section] key`, falling back to a dotted key in the parent section. */
function lookup(sections, section, key) {
  const direct = sections.get(section)?.get(key)
  const hit = normalizeHex(direct)
  if (hit) return hit

  const dot = section.indexOf('.')
  if (dot === -1) return null
  const parent = section.slice(0, dot)
  const suffix = section.slice(dot + 1)
  return normalizeHex(sections.get(parent)?.get(`${suffix}.${key}`))
}

/** Parse a theme's colors.toml (flat top-level keys). */
export function paletteFromColorsToml(text) {
  const sections = parseSections(text)
  const top = sections.get('')
  const get = (k) => normalizeHex(top.get(k))

  const palette = {
    accent: get('accent'),
    cursor: get('cursor'),
    foreground: get('foreground'),
    background: get('background'),
    selection_foreground: get('selection_foreground'),
    selection_background: get('selection_background'),
  }
  for (let i = 0; i < 16; i++) palette[`color${i}`] = get(`color${i}`)
  return palette
}

/** Derive a palette from alacritty.toml exactly the way Omarchy would. */
export function paletteFromAlacritty(text) {
  const sections = parseSections(text)
  const palette = {}

  // Normal colors are required — bail out like the upstream script does.
  for (let i = 0; i < 8; i++) {
    const value = lookup(sections, 'colors.normal', NORMAL_NAMES[i])
    if (!value) return null
    palette[`color${i}`] = value
  }

  // Bright colors fall back to their normal counterpart.
  for (let i = 0; i < 8; i++) {
    palette[`color${i + 8}`] =
      lookup(sections, 'colors.bright', NORMAL_NAMES[i]) ?? palette[`color${i}`]
  }

  const background = lookup(sections, 'colors.primary', 'background') ?? palette.color0
  const foreground = lookup(sections, 'colors.primary', 'foreground') ?? palette.color7
  const cursor = lookup(sections, 'colors.cursor', 'cursor') ?? foreground
  const selectionBackground = lookup(sections, 'colors.selection', 'background') ?? foreground
  const selectionForeground = lookup(sections, 'colors.selection', 'text') ?? background

  return {
    ...palette,
    accent: palette.color4,
    cursor,
    foreground,
    background,
    selection_foreground: selectionForeground,
    selection_background: selectionBackground,
  }
}

/**
 * Fill the gaps a partial colors.toml would leave. Omarchy's template pass
 * substitutes only the keys that exist, so a missing color0 ships a literal
 * `{{ color0 }}` into the generated config. We report those as warnings and
 * fill them so downstream rendering still works.
 */
export function completePalette(palette) {
  const filled = { ...palette }
  const missing = []

  for (let i = 0; i < 8; i++) {
    if (!filled[`color${i}`]) {
      missing.push(`color${i}`)
      filled[`color${i}`] = i === 0 ? filled.background : filled.foreground
    }
  }
  for (let i = 8; i < 16; i++) {
    if (!filled[`color${i}`]) {
      missing.push(`color${i}`)
      filled[`color${i}`] = filled[`color${i - 8}`]
    }
  }

  filled.accent ||= filled.color4
  filled.cursor ||= filled.foreground
  filled.selection_foreground ||= filled.background
  filled.selection_background ||= filled.foreground

  return { palette: filled, missing }
}

export function rgb(hex) {
  const h = hex.replace('#', '')
  return [
    parseInt(h.slice(0, 2), 16),
    parseInt(h.slice(2, 4), 16),
    parseInt(h.slice(4, 6), 16),
  ]
}

/** WCAG relative luminance, 0..1. */
export function luminance(hex) {
  const [r, g, b] = rgb(hex).map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/** Classify by background luminance. 0.4 sits well clear of every shipped theme. */
export function classifyMode(background) {
  return luminance(background) > 0.4 ? 'light' : 'dark'
}
