# Omarchy Theme Registry

A community index of [Omarchy](https://omarchy.org) themes, published as a static
JSON feed. Add a theme with a one-line PR; a bot validates it, renders its palette,
and the nightly build republishes the index.

**Index:** <https://andreas-bylund.github.io/omarchy-theme-registry/index.json>

The registry is deliberately not an app. It's a feed — the desktop theme browser is
one consumer, and any website or script is welcome to be another.

## Adding a theme

One file, one line. See [CONTRIBUTING.md](CONTRIBUTING.md).

```toml
# themes/rustleaf.toml
repo = "https://github.com/you/omarchy-rustleaf-theme"
```

## Consuming the index

```json
{
  "version": 1,
  "generated_at": "2026-08-11T03:17:04.000Z",
  "count": 128,
  "themes": [
    {
      "slug": "rustleaf",
      "name": "Rustleaf",
      "repo": "https://github.com/you/omarchy-rustleaf-theme",
      "clone_url": "https://github.com/you/omarchy-rustleaf-theme",
      "install": "omarchy-theme-install https://github.com/you/omarchy-rustleaf-theme",
      "commit": "a3f21c9…",
      "mode": "dark",
      "contrast": 8.94,
      "palette": {
        "background": "#1a1b26",
        "foreground": "#a9b1d6",
        "accent": "#7aa2f7",
        "cursor": "#c0caf5",
        "color0": "#32344a",
        "…": "through color15"
      },
      "palette_source": "colors.toml",
      "overrides": ["btop", "gtk", "hyprland", "waybar"],
      "backgrounds": 3,
      "thumb": "thumbs/rustleaf.webp",
      "wallpaper": "thumbs/rustleaf-wall.webp",
      "screenshot": "thumbs/rustleaf-shot.webp",
      "stars": 42,
      "license": "MIT",
      "owner": "you",
      "updated_at": "2026-03-29T20:44:00Z",
      "archived": false,
      "tags": ["warm"],
      "flags": [],
      "warnings": []
    }
  ]
}
```

Thumbnail paths are relative to the index URL. Fetch with `If-None-Match`; the
whole feed is one file and gzips to a fraction of its size.

### Fields worth understanding

**`slug`** is the directory name the theme gets in `~/.config/omarchy/themes/`,
derived from the repo URL the same way `omarchy-theme-install` derives it. That's
what lets a client diff the index against what's installed locally.

**`commit`** is upstream HEAD at build time. Compare it to
`git -C ~/.config/omarchy/themes/<slug> rev-parse HEAD` to know which installed
themes actually have updates — `omarchy-theme-update` just pulls everything blind.

**`overrides`** is not a compatibility list. Omarchy generates configs for
alacritty, ghostty, kitty, foot, waybar, walker, mako, swayosd, hyprland,
hyprlock, btop, helix, obsidian, chromium and the keyboard from the palette alone,
filling in only what the theme doesn't ship. So `overrides` says which files the
author hand-tuned — a craft signal, not a support matrix. `[]` is a perfectly good
theme.

**`palette_source`** is `colors.toml` or `alacritty.toml`. The latter means
Omarchy will synthesize `colors.toml` at install time via
`omarchy-theme-colors-from-alacritty`; the registry runs the same derivation so
what you see is what you'll get.

**`flags`** are risk notes, not rejections — `exec` directives, keybinds running
shell commands, executable files. They were reviewed before merge. Clients that
want to surface them ("this theme runs a command at startup") can.

**`thumb`** is a synthetic preview rendered from the palette: the same mock
desktop for every theme, so a grid is actually comparable. `screenshot` is the
author's own `preview.png` if they shipped one — better for a detail view, useless
for a grid. `wallpaper` is the theme's first background image.

## Used by

**[omarchythemes.co](https://omarchythemes.co)** — a browsable gallery built on
this feed. It reads `index.json` and turns it into search, filters (dark/light,
tags, which apps a theme hand-tunes), sorting (stars, last updated, contrast,
number of overrides), the palette preview, and a copyable
`omarchy-theme-install` line per theme. Nothing about it is privileged — it reads
exactly the file everyone else reads.

Using the index somewhere? Open a PR adding it here.

### Fetching it yourself

```js
const INDEX = 'https://andreas-bylund.github.io/omarchy-theme-registry/index.json'

const registry = await fetch(INDEX).then((r) => r.json())

const darkThemes = registry.themes
  .filter((t) => t.mode === 'dark' && !t.archived)
  .sort((a, b) => b.stars - a.stars)
  .map((t) => ({
    name: t.name,
    install: t.install,
    // Paths are relative to the index URL; render_version busts stale previews.
    thumb: `${new URL(t.thumb, INDEX).href}?v=${registry.render_version}`,
  }))
```

```bash
curl -s https://andreas-bylund.github.io/omarchy-theme-registry/index.json \
  | jq -r '.themes[] | select(.contrast > 7) | .install'
```

One caveat if you cache images: thumbnail paths are stable across re-renders, so
a client that already fetched `thumbs/foo.webp` will keep serving its own copy
after the registry republishes it. The top-level `render_version` changes whenever
the renderer does — append it as a query string (`thumbs/foo.webp?v=3`) and stale
previews take care of themselves.

## Repo layout

```
themes/            one .toml per theme — the registry itself
src/validate.js    PR gate: clone, inspect, render a report
src/build.js       nightly: build index.json + thumbnails into dist/
src/crawl.js       discovery: find themes on GitHub, propose them as a PR
src/lib/           palette extraction, slug rules, mock renderer
```

## Local development

```bash
npm ci

npm run validate                        # check every submission
node src/validate.js themes/foo.toml    # check one
npm run build                           # write dist/index.json + dist/thumbs/
npm run crawl                           # dry-run discovery
```

`GITHUB_TOKEN` is optional locally but raises the API rate limit a lot — set it if
you're building the whole registry.

## How themes get in

Two paths, same gate:

1. **Someone opens a PR.** One line, bot validates, human merges.
2. **The crawler proposes.** Daily, it searches `topic:omarchy-theme`,
   `topic:omarchy-themes` and repos named `omarchy *theme*`, clones and validates
   each candidate, and opens a single PR with everything that passed — at most 50
   at a time, and only when the last proposal has been dealt with.

The crawler exists because nobody submits to an empty registry. It proposes; it
never vouches. Merging is always a human call.

## Design notes

**Slugs are first-come and unique.** Two themes deriving the same slug would
clobber each other on disk — `omarchy-theme-install` `rm -rf`s the target
directory before cloning. Enforcing uniqueness here is the only place the
collision can be caught before it eats someone's theme.

**The build is incremental.** Each run resolves upstream HEAD with `git ls-remote`
(no clone) and reuses the cached entry and thumbnails when the SHA hasn't moved.
Only changed themes are cloned and re-rendered.

**Unreachable themes aren't dropped.** If a host has a bad night, the last
known-good entry is republished with `"unreachable": true` rather than vanishing
from the index.

**Non-GitHub themes work.** Everything except stars, license and description comes
from the clone, and `git ls-remote` is host-agnostic. GitHub metadata is
enrichment, not a requirement.

## License

[MIT](LICENSE) — the registry code, the submission files and the published index
alike. Build something on the feed; you don't need to ask.

The themes it points at are other people's repos under their own licenses. The
index reports each one's `license` field; it doesn't relicense anything.
