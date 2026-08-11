import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  classifyMode,
  completePalette,
  contrastRatio,
  paletteFromAlacritty,
  paletteFromColorsToml,
} from './colors.js'

// Files a theme can ship to override what Omarchy would otherwise generate from
// the palette via ~/.local/share/omarchy/default/themed/*.tpl. Shipping none of
// these is fine — it means the theme is fully template-driven.
const OVERRIDE_FILES = {
  'alacritty.toml': 'alacritty',
  'ghostty.conf': 'ghostty',
  'kitty.conf': 'kitty',
  'foot.ini': 'foot',
  'waybar.css': 'waybar',
  'walker.css': 'walker',
  'wofi.css': 'wofi',
  'mako.ini': 'mako',
  'swayosd.css': 'swayosd',
  'hyprland.conf': 'hyprland',
  'hyprlock.conf': 'hyprlock',
  'btop.theme': 'btop',
  'neovim.lua': 'neovim',
  'helix.toml': 'helix',
  'gtk.css': 'gtk',
  'icons.theme': 'icons',
  'vscode.json': 'vscode',
  'obsidian.css': 'obsidian',
  'chromium.theme': 'chromium',
  'keyboard.rgb': 'keyboard',
}

const SCREENSHOT_CANDIDATES = [
  'preview.png',
  'preview.jpg',
  'preview.jpeg',
  'preview.webp',
  'screenshot.png',
  'screenshot.jpg',
]

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif'])

// Themes are arbitrary git repos, and a theme's hyprland.conf is sourced straight
// into the user's Hyprland config while neovim.lua is loaded as code. Those are
// the files that can actually *do* something — CSS, JSON and TOML cannot, so
// scanning them only produces false positives (ASCII-art banners full of
// backticks are common in theme repos).
//
// None of these are automatic rejections. Some are legitimate: a hyprlock clock
// genuinely needs `cmd[]`. They exist so a human looks before merging.
const RISK_RULES = [
  {
    exts: ['.conf'],
    re: /^\s*exec(-once)?\s*=/im,
    note: 'runs a command on Hyprland start (`exec` / `exec-once`)',
  },
  {
    exts: ['.conf'],
    re: /^\s*bind[a-z]*\s*=[^\n]*,\s*exec\s*,/im,
    note: 'binds a key to a shell command',
  },
  {
    exts: ['.conf'],
    re: /^\s*source\s*=\s*[~/$]/im,
    note: 'sources a config from outside the theme directory',
  },
  {
    exts: ['.conf'],
    re: /\$\(|\bcmd\s*\[/i,
    note: 'runs a shell command (hyprlock `cmd[]` or `$(…)` substitution)',
  },
  {
    exts: ['.lua'],
    re: /\b(os\.execute|io\.popen|loadstring|load\s*\()/,
    note: 'executes code or shells out from Lua',
  },
]

const SCANNED_EXT = new Set(['.conf', '.lua'])

/** Drop `#` and `--` comments so banner art doesn't trip the risk rules. */
function stripComments(text, ext) {
  const marker = ext === '.lua' ? /--.*$/ : /#.*$/
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(marker, ''))
    .join('\n')
}

async function listFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath ?? e.path, e.name)))
    .filter((rel) => !rel.startsWith('.git' + path.sep) && rel !== '.git')
}

async function readIfExists(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Inspect a cloned theme directory.
 * Never throws on bad themes — problems come back as `errors` so the caller can
 * report all of them at once instead of failing on the first.
 */
export async function inspectTheme(dir) {
  const errors = []
  const warnings = []
  const files = await listFiles(dir)
  const byName = new Set(files)

  // --- palette -----------------------------------------------------------
  let palette = null
  let paletteSource = null

  const colorsToml = await readIfExists(path.join(dir, 'colors.toml'))
  if (colorsToml) {
    palette = paletteFromColorsToml(colorsToml)
    paletteSource = 'colors.toml'
  } else {
    const alacritty = await readIfExists(path.join(dir, 'alacritty.toml'))
    if (alacritty) {
      palette = paletteFromAlacritty(alacritty)
      paletteSource = 'alacritty.toml'
      if (!palette) {
        errors.push(
          'alacritty.toml is missing one or more `[colors.normal]` entries, so Omarchy cannot ' +
            'derive colors.toml from it (see omarchy-theme-colors-from-alacritty).',
        )
      }
    }
  }

  if (!palette) {
    if (!paletteSource) {
      errors.push('No colors.toml and no alacritty.toml — Omarchy has no palette to theme from.')
    }
    return { ok: false, errors, warnings, files }
  }

  if (!palette.background || !palette.foreground) {
    errors.push('Palette is missing `background` and/or `foreground`.')
    return { ok: false, errors, warnings, files }
  }

  const { palette: complete, missing } = completePalette(palette)
  if (missing.length) {
    warnings.push(
      `colors.toml is missing ${missing.join(', ')} — Omarchy's template pass leaves those as ` +
        `literal \`{{ ${missing[0]} }}\` in the generated configs. Filled in for the preview.`,
    )
  }

  const contrast = contrastRatio(complete.foreground, complete.background)
  if (contrast < 4.5) {
    warnings.push(
      `Foreground/background contrast is ${contrast.toFixed(2)}:1 (below the 4.5:1 readability floor).`,
    )
  }

  // --- what the author hand-tuned ---------------------------------------
  const overrides = Object.entries(OVERRIDE_FILES)
    .filter(([file]) => byName.has(file))
    .map(([, app]) => app)
    .sort()

  // --- wallpapers --------------------------------------------------------
  const backgrounds = files
    .filter((f) => f.startsWith('backgrounds' + path.sep) && IMAGE_EXT.has(path.extname(f).toLowerCase()))
    .sort()

  if (!backgrounds.length) {
    warnings.push('No backgrounds/ directory — the user keeps whatever wallpaper they had.')
  }

  const screenshot = SCREENSHOT_CANDIDATES.find((f) => byName.has(f)) ?? null

  const hasLicense = files.some((f) => /^LICENSE(\.\w+)?$/i.test(f))
  if (!hasLicense) {
    warnings.push('No LICENSE file — users cloning this have no stated terms.')
  }

  // --- risk scan ---------------------------------------------------------
  const flags = []
  for (const rel of files) {
    const ext = path.extname(rel).toLowerCase()
    if (!SCANNED_EXT.has(ext)) continue

    const raw = await readIfExists(path.join(dir, rel))
    if (!raw) continue

    const text = stripComments(raw, ext)
    for (const { exts, re, note } of RISK_RULES) {
      if (exts.includes(ext) && re.test(text)) flags.push({ file: rel, note })
    }
  }
  for (const rel of files) {
    if (path.extname(rel).toLowerCase() === '.sh') {
      flags.push({ file: rel, note: 'ships a shell script' })
      continue
    }
    const info = await stat(path.join(dir, rel))
    if (info.mode & 0o111 && !rel.startsWith('.git')) {
      flags.push({ file: rel, note: 'is marked executable' })
    }
  }

  return {
    ok: true,
    errors,
    warnings,
    files,
    palette: complete,
    paletteSource,
    mode: classifyMode(complete.background),
    contrast: Number(contrast.toFixed(2)),
    overrides,
    backgrounds,
    screenshot,
    flags: dedupeFlags(flags),
    hasLicense,
    hasReadme: files.some((f) => /^README(\.\w+)?$/i.test(f)),
  }
}

function dedupeFlags(flags) {
  const seen = new Set()
  return flags.filter(({ file, note }) => {
    const key = `${file}::${note}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
