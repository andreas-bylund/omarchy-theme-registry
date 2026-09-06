import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { inspectTheme } from './inspect.js'

const PALETTE = `background = "#111111"\nforeground = "#eeeeee"\naccent = "#ff0000"\n`

async function withTheme(files, fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'omarchy-inspect-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const dest = path.join(dir, rel)
      await mkdir(path.dirname(dest), { recursive: true })
      await writeFile(dest, body)
      if (rel.endsWith('.sh')) await chmod(dest, 0o755)
    }
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('inspectTheme', () => {
  it('accepts a palette-only theme as a real theme with no flags', async () => {
    const inspection = await withTheme({ 'colors.toml': PALETTE }, inspectTheme)
    assert.equal(inspection.ok, true)
    assert.equal(inspection.flags.length, 0)
    assert.equal(inspection.mode, 'dark')
  })

  it('tags exec-once as high and hyprlock cmd[] as low', async () => {
    const inspection = await withTheme(
      {
        'colors.toml': PALETTE,
        'hyprland.conf': 'exec-once = waybar\n',
        'hyprlock.conf': 'text = cmd[update:1000] date\n',
      },
      inspectTheme,
    )
    assert.equal(inspection.ok, true)
    const byFile = Object.fromEntries(inspection.flags.map((f) => [f.file, f]))
    assert.equal(byFile['hyprland.conf'].severity, 'high')
    assert.equal(byFile['hyprlock.conf'].severity, 'low')
  })

  it('flags a spoofing script as suspicious/high', async () => {
    const inspection = await withTheme(
      {
        'colors.toml': PALETTE,
        'mac-spoofer.sh': '#!/bin/sh\necho hi\n',
      },
      inspectTheme,
    )
    assert.ok(inspection.flags.some((f) => /suspicious filename/i.test(f.note)))
    assert.ok(inspection.flags.some((f) => f.file === 'mac-spoofer.sh' && f.severity === 'high'))
  })

  it('treats test-colors.sh as a low-severity script', async () => {
    const inspection = await withTheme(
      {
        'colors.toml': PALETTE,
        'test-colors.sh': '#!/bin/sh\necho hi\n',
      },
      inspectTheme,
    )
    const script = inspection.flags.find((f) => f.note === 'ships a shell script')
    assert.equal(script.severity, 'low')
  })
})
