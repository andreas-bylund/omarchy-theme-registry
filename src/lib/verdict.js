// Merge-safety summary for a batch of inspected themes.
//
// The long per-theme report is for looking. This is the thing you read before
// pressing merge: is every submission actually a theme, and is any of them
// going to run code on the user's machine?

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 }

export function flagSeverity(flag) {
  return SEVERITY_RANK[flag?.severity] ? flag.severity : 'medium'
}

export function maxSeverity(flags = []) {
  let max = null
  for (const flag of flags) {
    const sev = flagSeverity(flag)
    if (!max || SEVERITY_RANK[sev] > SEVERITY_RANK[max]) max = sev
  }
  return max
}

function scriptCount(flags = []) {
  return flags.filter((f) => /shell script/i.test(f.note)).length
}

/** A palette plus a toolbelt is how the denylist earned its first entry. */
export function looksLikeToolbelt(inspection) {
  if (!inspection?.ok) return false
  const flags = inspection.flags ?? []
  if (flags.some((f) => /suspicious filename/i.test(f.note))) return true
  if (scriptCount(flags) >= 5) return true
  if (flags.length >= 12) return true
  return false
}

function needsHumanGlance(result) {
  const flags = result.inspection?.flags ?? []
  if (looksLikeToolbelt(result.inspection)) return true
  if (flags.some((f) => flagSeverity(f) !== 'low')) return true
  if (result.meta?.archived) return true
  const warnings = result.inspection?.warnings ?? []
  if (warnings.some((w) => /don't belong in a theme/i.test(w))) return true
  return false
}

/**
 * Classify a batch of analyze()/inspect results plus any registry-level errors
 * (denylist, bad TOML, slug mismatch) that never made it to a clone.
 *
 * `level`:
 *   safe    — every submission is a real theme, nothing runs code
 *   review  — real themes, but at least one ships exec/scripts/keybinds
 *   unsafe  — something is not a theme, is a toolbelt, or failed to clone
 */
export function summarize({ results = [], registryErrors = [] } = {}) {
  const failed = []
  const review = []
  const clean = []
  const toolbelts = []
  const benign = [] // valid theme, only low-severity flags

  for (const result of results) {
    if (!result.inspection?.ok) {
      failed.push(result)
      continue
    }
    if (looksLikeToolbelt(result.inspection)) {
      toolbelts.push(result)
      review.push(result)
      continue
    }
    if (needsHumanGlance(result)) {
      review.push(result)
      continue
    }
    if ((result.inspection.flags ?? []).length) benign.push(result)
    clean.push(result)
  }

  const hardErrors = registryErrors.length + failed.length + toolbelts.length
  let level = 'safe'
  if (hardErrors) level = 'unsafe'
  else if (review.length) level = 'review'

  return {
    level,
    failed,
    review,
    clean,
    toolbelts,
    benign,
    counts: {
      proposed: results.length,
      real: results.filter((r) => r.inspection?.ok).length,
      clean: clean.length,
      review: review.length,
      failed: failed.length,
      toolbelts: toolbelts.length,
      registryErrors: registryErrors.length,
      flags: results.reduce((n, r) => n + (r.inspection?.flags?.length ?? 0), 0),
    },
  }
}

function slugOf(result) {
  return result.entry?.slug ?? result.slug ?? '?'
}

function flagTally(result) {
  const flags = result.inspection?.flags ?? []
  if (!flags.length) return ''
  const high = flags.filter((f) => flagSeverity(f) === 'high').length
  const medium = flags.filter((f) => flagSeverity(f) === 'medium').length
  const low = flags.filter((f) => flagSeverity(f) === 'low').length
  const parts = []
  if (high) parts.push(`${high} high`)
  if (medium) parts.push(`${medium} medium`)
  if (low) parts.push(`${low} low`)
  return parts.join(', ')
}

/**
 * Markdown block meant to sit at the *bottom* of a PR body or validation
 * comment — after the long per-theme list — so the merge decision is the last
 * thing a reviewer sees.
 */
export function renderVerdict(summary, { heading = 'Merge verdict' } = {}) {
  const { level, failed, review, clean, toolbelts, benign, counts } = summary
  const lines = ['---', '', `## ${heading}`, '']

  lines.push(
    '| | Count |',
    '| --- | ---: |',
    `| Submissions | ${counts.proposed} |`,
    `| Real themes (palette cloned and parsed) | ${counts.real} |`,
    `| Clean | ${counts.clean} |`,
    `| Need a human glance | ${counts.review} |`,
    `| Failed / not a theme | ${counts.failed} |`,
  )
  if (counts.registryErrors) {
    lines.push(`| Submission-format errors | ${counts.registryErrors} |`)
  }
  lines.push('')

  if (level === 'safe') {
    lines.push('### ✅ Safe to merge', '')
    lines.push(
      `All **${counts.real}** submission${counts.real === 1 ? ' is' : 's are'} ` +
        `real Omarchy theme${counts.real === 1 ? '' : 's'} — each cloned, and each ` +
        `has a \`colors.toml\` or a complete \`alacritty.toml\` palette.`,
    )
    if (benign.length) {
      lines.push(
        '',
        `${benign.length} ha${benign.length === 1 ? 's' : 've'} only benign notes ` +
          `(hyprlock clocks, test scripts, stray executable bits): ` +
          benign.map((r) => `\`${slugOf(r)}\``).join(', ') +
          '. Those do not block merge.',
      )
    } else {
      lines.push(
        '',
        'None ship `exec` / `exec-once`, keybind-to-shell, outside `source`, ' +
          'Lua shell-out, non-test shell scripts, or suspicious filenames.',
      )
    }
    lines.push('', 'Nothing on this list is a denylist hit or a failed clone.')
  } else if (level === 'review') {
    lines.push('### ⚠️ Needs review — not automatically safe to merge', '')
    lines.push(
      `Every submission is a real Omarchy theme (palette present). **${review.length}** ` +
        `of them ${review.length === 1 ? 'ships' : 'ship'} commands or scripts that Hyprland or Lua would run. ` +
        `The other **${clean.length}** ${clean.length === 1 ? 'is' : 'are'} clean.`,
      '',
      '**Look at these before merging:**',
      '',
    )
    for (const result of review) {
      const tally = flagTally(result)
      const extra = result.meta?.archived ? ' · archived upstream' : ''
      lines.push(
        `- \`${slugOf(result)}\`${tally ? ` — ${tally} risk flag(s)` : ''}${extra}` +
          (looksLikeToolbelt(result.inspection) ? ' — **looks like a toolbelt, not a theme**' : ''),
      )
    }
    lines.push(
      '',
      'Risk flags are not automatic rejections — a hyprlock clock is fine — but ' +
        '`exec-once`, outside `source`, Lua `os.execute`, and shell scripts need a reading.',
    )
  } else {
    lines.push('### ❌ Do not merge', '')
    const reasons = []
    if (counts.registryErrors) {
      reasons.push(
        `**${counts.registryErrors}** submission-format error${counts.registryErrors === 1 ? '' : 's'} ` +
          `(denylist, slug mismatch, or bad TOML).`,
      )
    }
    if (failed.length) {
      reasons.push(
        `**${failed.length}** submission${failed.length === 1 ? '' : 's'} failed inspection — ` +
          `not a usable Omarchy theme, or the repo could not be cloned.`,
      )
    }
    if (toolbelts.length) {
      reasons.push(
        `**${toolbelts.length}** look${toolbelts.length === 1 ? 's' : ''} like a toolbelt wearing a theme's clothes ` +
          `(suspicious filenames, a pile of shell scripts, or a very large risk-flag count).`,
      )
    }
    lines.push(reasons.join(' '), '')

    if (failed.length) {
      lines.push('**Failed:**', '')
      for (const result of failed) {
        const errors = result.inspection?.errors ?? ['unknown error']
        lines.push(`- \`${slugOf(result)}\` — ${errors.join('; ')}`)
      }
      lines.push('')
    }
    if (toolbelts.length) {
      lines.push('**Toolbelt / not-a-theme:**', '')
      for (const result of toolbelts) {
        lines.push(`- \`${slugOf(result)}\` — ${flagTally(result) || 'suspicious contents'}`)
      }
      lines.push('')
    }
    if (review.length && review.length !== toolbelts.length) {
      const rest = review.filter((r) => !toolbelts.includes(r))
      if (rest.length) {
        lines.push(
          `${rest.length} other theme${rest.length === 1 ? '' : 's'} would need a glance even after the blockers are gone: ` +
            rest.map((r) => `\`${slugOf(r)}\``).join(', ') +
            '.',
          '',
        )
      }
    }
    if (failed.length === 0 && counts.registryErrors === 0 && toolbelts.length) {
      lines.push(
        '**Do not merge as-is.** Drop the toolbelt repo(s) from this PR and add them to `denied.toml` ' +
          'with a reason — otherwise the crawler will propose them again tomorrow. ' +
          (clean.length
            ? `The remaining **${clean.length}** theme${clean.length === 1 ? '' : 's'} ${clean.length === 1 ? 'is' : 'are'} fine to keep.`
            : 'Nothing else in this batch is mergeable.'),
      )
    } else {
      lines.push('CI is red for a reason. Do not merge until the blockers are gone or denied.')
    }
  }

  lines.push('')
  return lines.join('\n')
}

/** One-line status for the top of a long report, so you don't have to scroll. */
export function renderStatusLine(summary) {
  const { level, counts } = summary
  const icon = level === 'safe' ? '✅' : level === 'review' ? '⚠️' : '❌'
  const label =
    level === 'safe' ? 'Safe to merge' : level === 'review' ? 'Needs review' : 'Do not merge'
  return (
    `${icon} **${label}** — ${counts.proposed} submission${counts.proposed === 1 ? '' : 's'}` +
    ` · ${counts.real} real theme${counts.real === 1 ? '' : 's'}` +
    ` · ${counts.clean} clean` +
    ` · ${counts.review} need a glance` +
    ` · ${counts.failed} failed` +
    (counts.registryErrors ? ` · ${counts.registryErrors} format error(s)` : '') +
    '.'
  )
}
