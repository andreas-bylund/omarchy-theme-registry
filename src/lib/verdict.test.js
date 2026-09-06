import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  looksLikeToolbelt,
  renderStatusLine,
  renderVerdict,
  summarize,
} from './verdict.js'

function result(slug, { ok = true, flags = [], errors = [], warnings = [], archived = false } = {}) {
  return {
    entry: { slug, file: `themes/${slug}.toml`, repo: `https://github.com/x/${slug}` },
    inspection: { ok, flags, errors, warnings },
    meta: archived ? { archived: true } : { archived: false, stars: 1 },
  }
}

describe('summarize', () => {
  it('calls a batch of real themes with no flags safe', () => {
    const summary = summarize({
      results: [result('rustleaf'), result('solitude')],
    })
    assert.equal(summary.level, 'safe')
    assert.equal(summary.counts.real, 2)
    assert.equal(summary.counts.clean, 2)
    assert.match(renderVerdict(summary), /Safe to merge/)
    assert.match(renderStatusLine(summary), /Safe to merge/)
  })

  it('treats only-low flags as clean, not a review blocker', () => {
    const summary = summarize({
      results: [
        result('clock', {
          flags: [{ file: 'hyprlock.conf', note: 'runs a shell command (hyprlock `cmd[]`)', severity: 'low' }],
        }),
      ],
    })
    assert.equal(summary.level, 'safe')
    assert.equal(summary.benign.length, 1)
    assert.match(renderVerdict(summary), /benign notes/)
  })

  it('asks for a glance when a theme ships exec or scripts', () => {
    const summary = summarize({
      results: [
        result('clean'),
        result('wired', {
          flags: [{ file: 'hyprland.conf', note: 'runs a command on Hyprland start', severity: 'high' }],
        }),
      ],
    })
    assert.equal(summary.level, 'review')
    assert.equal(summary.counts.clean, 1)
    assert.equal(summary.counts.review, 1)
    const md = renderVerdict(summary)
    assert.match(md, /Needs review/)
    assert.match(md, /`wired`/)
    assert.doesNotMatch(md, /Do not merge/)
  })

  it('is unsafe when something is not a theme', () => {
    const summary = summarize({
      results: [
        result('ok'),
        result('empty', { ok: false, errors: ['No colors.toml and no alacritty.toml'] }),
      ],
    })
    assert.equal(summary.level, 'unsafe')
    assert.match(renderVerdict(summary), /Do not merge/)
    assert.match(renderVerdict(summary), /empty/)
  })

  it('is unsafe on denylist / format errors even if clones look fine', () => {
    const summary = summarize({
      results: [result('ok')],
      registryErrors: ['themes/bad.toml: this repo is on the denylist'],
    })
    assert.equal(summary.level, 'unsafe')
    assert.match(renderVerdict(summary), /submission-format error/)
  })

  it('treats a toolbelt as unsafe, not merely review', () => {
    const flags = [
      { file: 'mac-spoofer.sh', note: 'suspicious filename — not typical of a theme', severity: 'high' },
      { file: 'shredder.sh', note: 'ships a shell script', severity: 'medium' },
      { file: 'a.sh', note: 'ships a shell script', severity: 'medium' },
      { file: 'b.sh', note: 'ships a shell script', severity: 'medium' },
      { file: 'c.sh', note: 'ships a shell script', severity: 'medium' },
      { file: 'd.sh', note: 'ships a shell script', severity: 'medium' },
    ]
    assert.equal(looksLikeToolbelt({ ok: true, flags }), true)
    const summary = summarize({ results: [result('macchiato', { flags })] })
    assert.equal(summary.level, 'unsafe')
    assert.equal(summary.toolbelts.length, 1)
    assert.match(renderVerdict(summary), /toolbelt/)
  })
})
