# Adding a theme

Create one file: `themes/<slug>.toml`

```toml
repo = "https://github.com/you/omarchy-yourtheme-theme"
```

That is the whole submission. Everything else — palette, light/dark, wallpapers,
overrides, license, stars — is read from your repo by CI. Open a PR and a bot
replies with your palette rendered as color chips, so review is a look, not an audit.

## Picking the filename

The filename is not free. Omarchy derives the installed directory name from your
repo URL, and the registry has to use the same one or the desktop app can't tell
which of your installed themes an index entry refers to.

The rule, from `omarchy-theme-install`:

```
basename → strip ".git" → strip a leading "omarchy-" → strip a trailing "-theme" → lowercase
```

| Repo | Slug | File |
| --- | --- | --- |
| `github.com/you/omarchy-rustleaf-theme` | `rustleaf` | `themes/rustleaf.toml` |
| `github.com/you/omarchy-dune-messiah` | `dune-messiah` | `themes/dune-messiah.toml` |
| `github.com/you/solitude` | `solitude` | `themes/solitude.toml` |

CI checks this and tells you the exact filename to use if you get it wrong.

**Slugs are unique and first-come.** Two themes that derive the same slug would
overwrite each other in `~/.config/omarchy/themes/` — `omarchy-theme-install`
literally `rm -rf`s the existing directory before cloning. If your slug is taken,
rename your repo.

## Optional fields

```toml
repo = "https://github.com/you/omarchy-yourtheme-theme"
tags = ["warm", "low-contrast"]     # max 8, free-form, lowercase
note = "Companion to the Foo colorscheme"
```

Don't add `dark`/`light` — that's computed from your background's luminance.

## What CI checks

**Hard requirements** (these fail the PR):

- The repo clones.
- It has a `colors.toml`, **or** an `alacritty.toml` with a complete
  `[colors.normal]` block that Omarchy can derive `colors.toml` from.
- `background` and `foreground` resolve to real hex colors.
- The filename matches the derived slug.
- No other entry points at the same repo.
- The repo isn't in `denied.toml` — the list of repos the registry has already
  looked at and turned down, each with a reason. If yours is on it and you've
  since fixed what it says, remove the entry in the same PR and explain the fix;
  a reviewer will read both.

**Warnings** (surfaced to the reviewer, don't block):

- Missing `color0`–`color15`. Omarchy's template pass substitutes only the keys
  that exist, so a missing `color5` ships a literal `{{ color5 }}` into the
  generated waybar/mako/btop config.
- Foreground/background contrast below 4.5:1.
- No `backgrounds/` directory, no `LICENSE`.
- The repo is archived upstream.

**Risk flags** (labels the PR `needs-review`):

Themes are arbitrary git repos, and a theme's `hyprland.conf` is sourced straight
into the user's Hyprland config. CI flags `exec` / `exec-once`, keybinds that run
shell commands, `source =` pointing outside the theme, command substitution, shell
scripts, and executable files. None of these are automatic rejections — some are
legitimate — but a human looks before merge.

## You don't need to ship config files

`omarchy-theme-set-templates` generates alacritty, ghostty, kitty, foot, waybar,
walker, mako, swayosd, hyprland, hyprlock, btop, helix, obsidian, chromium and
keyboard configs from your palette — but only for files your theme doesn't already
provide. A theme with nothing but `colors.toml` themes the whole desktop.

Files you *do* ship are hand-tuned overrides. The index records which ones, so
users can find the themes someone actually sweated over.

## Running the checks locally

```bash
npm ci
node src/validate.js themes/yourtheme.toml
```

## Licensing

Contributions to this repo — the `.toml` entry, code, docs — are MIT, same as the
rest of it. Your theme repo keeps whatever license you gave it; submitting it here
only adds a pointer to the index.
