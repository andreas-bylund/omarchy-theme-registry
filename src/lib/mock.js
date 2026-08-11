// Builds a synthetic desktop preview from a theme's palette.
//
// Every theme gets the *same* mock, which is the whole point: a grid of 200
// heterogeneous user screenshots is unusable for comparison, a grid of 200
// identical layouts differing only in color is instantly readable.
//
// Deliberately text-free — the "text" is rectangles. That keeps rendering
// independent of which fonts happen to be installed on the CI runner, so a
// given palette always produces a byte-identical thumbnail.

export const MOCK_WIDTH = 640
export const MOCK_HEIGHT = 400

// Fixed, not random: thumbnails must be reproducible across builds.
const TERMINAL_LINES = [
  { indent: 0, runs: [[26, 'color2'], [58, 'fg']] },
  { indent: 0, runs: [[120, 'fg-dim']] },
  { indent: 12, runs: [[44, 'color4'], [86, 'fg-dim']] },
  { indent: 12, runs: [[70, 'color4'], [38, 'color3']] },
  { indent: 0, runs: [[26, 'color2'], [92, 'fg']] },
  { indent: 12, runs: [[54, 'color5'], [104, 'fg-dim']] },
  { indent: 12, runs: [[38, 'color1'], [62, 'fg-dim']] },
  { indent: 0, runs: [[26, 'color2'], [40, 'fg']], cursor: true },
]

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')

const rect = (x, y, w, h, fill, { rx = 0, opacity = 1 } = {}) =>
  `<rect x="${round(x)}" y="${round(y)}" width="${round(w)}" height="${round(h)}" ` +
  `fill="${escape(fill)}"${rx ? ` rx="${rx}"` : ''}${opacity !== 1 ? ` opacity="${opacity}"` : ''}/>`

const round = (n) => Math.round(n * 100) / 100

export function buildMockSvg(palette) {
  const c = (key) => palette[key] ?? palette.foreground
  const bg = palette.background
  const fg = palette.foreground
  const accent = palette.accent ?? palette.color4
  const surface = palette.color0
  const parts = []

  const paint = (fill, opacity) => (fill === 'fg' ? [fg, opacity ?? 1] : fill === 'fg-dim' ? [fg, 0.45] : [c(fill), opacity ?? 1])

  // --- desktop -----------------------------------------------------------
  parts.push(
    `<defs><linearGradient id="d" x1="0" y1="0" x2="0.4" y2="1">` +
      `<stop offset="0" stop-color="${escape(surface)}"/>` +
      `<stop offset="1" stop-color="${escape(bg)}"/>` +
      `</linearGradient></defs>`,
  )
  parts.push(rect(0, 0, MOCK_WIDTH, MOCK_HEIGHT, 'url(#d)'))

  // --- waybar ------------------------------------------------------------
  const barH = 28
  parts.push(rect(0, 0, MOCK_WIDTH, barH, surface))
  parts.push(rect(0, barH - 1, MOCK_WIDTH, 1, fg, { opacity: 0.12 }))

  let x = 14
  for (const [i, w] of [16, 12, 12, 12].entries()) {
    const active = i === 0
    parts.push(rect(x, 9, w, 10, active ? accent : fg, { rx: 3, opacity: active ? 1 : 0.35 }))
    x += w + 6
  }
  let rightX = MOCK_WIDTH - 14
  for (const [w, key] of [[40, 'color4'], [24, 'color3'], [24, 'color2'], [24, 'color1']]) {
    rightX -= w
    parts.push(rect(rightX, 9, w, 10, c(key), { rx: 3, opacity: 0.9 }))
    rightX -= 8
  }

  // --- terminal window ---------------------------------------------------
  const term = { x: 36, y: 62, w: 364, h: 246 }
  parts.push(rect(term.x + 4, term.y + 6, term.w, term.h, '#000000', { rx: 10, opacity: 0.22 }))
  parts.push(rect(term.x, term.y, term.w, term.h, bg, { rx: 10 }))
  parts.push(rect(term.x, term.y, term.w, 26, surface, { rx: 10 }))
  parts.push(rect(term.x, term.y + 16, term.w, 10, surface))
  parts.push(rect(term.x, term.y + 26, term.w, 1, fg, { opacity: 0.12 }))
  for (const [i, key] of ['color1', 'color3', 'color2'].entries()) {
    parts.push(`<circle cx="${term.x + 16 + i * 14}" cy="${term.y + 13}" r="4" fill="${escape(c(key))}"/>`)
  }
  parts.push(rect(term.x + 66, term.y + 10, 78, 6, fg, { rx: 3, opacity: 0.3 }))

  let ty = term.y + 42
  for (const line of TERMINAL_LINES) {
    let tx = term.x + 16 + line.indent
    for (const [w, key] of line.runs) {
      const [fill, opacity] = paint(key)
      parts.push(rect(tx, ty, w, 7, fill, { rx: 2, opacity }))
      tx += w + 7
    }
    if (line.cursor) parts.push(rect(tx, ty - 2, 8, 11, palette.cursor ?? fg, { rx: 1 }))
    ty += 18
  }

  // --- mako notification -------------------------------------------------
  const note = { x: 424, y: 62, w: 180, h: 62 }
  parts.push(rect(note.x + 3, note.y + 5, note.w, note.h, '#000000', { rx: 8, opacity: 0.22 }))
  parts.push(rect(note.x, note.y, note.w, note.h, surface, { rx: 8 }))
  parts.push(rect(note.x, note.y + 8, 3, note.h - 16, accent, { rx: 2 }))
  parts.push(rect(note.x + 16, note.y + 16, 90, 7, fg, { rx: 2 }))
  parts.push(rect(note.x + 16, note.y + 31, 148, 6, fg, { rx: 2, opacity: 0.45 }))
  parts.push(rect(note.x + 16, note.y + 43, 108, 6, fg, { rx: 2, opacity: 0.45 }))

  // --- walker launcher ---------------------------------------------------
  const walker = { x: 424, y: 140, w: 180, h: 168 }
  parts.push(rect(walker.x + 3, walker.y + 5, walker.w, walker.h, '#000000', { rx: 8, opacity: 0.22 }))
  parts.push(rect(walker.x, walker.y, walker.w, walker.h, surface, { rx: 8 }))
  parts.push(rect(walker.x + 14, walker.y + 14, 152, 20, bg, { rx: 5 }))
  parts.push(rect(walker.x + 22, walker.y + 21, 62, 6, fg, { rx: 2, opacity: 0.55 }))
  parts.push(rect(walker.x + 86, walker.y + 19, 2, 10, accent))

  const rows = [true, false, false, false]
  rows.forEach((selected, i) => {
    const ry = walker.y + 46 + i * 29
    if (selected) parts.push(rect(walker.x + 10, ry - 6, walker.w - 20, 26, accent, { rx: 5, opacity: 0.9 }))
    parts.push(rect(walker.x + 20, ry, 12, 12, c(`color${i + 2}`), { rx: 3, opacity: selected ? 1 : 0.8 }))
    parts.push(
      rect(walker.x + 42, ry + 3, 100 - i * 12, 6, selected ? bg : fg, {
        rx: 2,
        opacity: selected ? 0.85 : 0.5,
      }),
    )
  })

  // --- palette strip -----------------------------------------------------
  const strip = { y: 332, h: 34, pad: 36 }
  const swatchW = (MOCK_WIDTH - strip.pad * 2) / 16
  for (let i = 0; i < 16; i++) {
    parts.push(rect(strip.pad + i * swatchW, strip.y, swatchW + 0.5, strip.h, c(`color${i}`)))
  }
  parts.push(rect(strip.pad, strip.y, MOCK_WIDTH - strip.pad * 2, strip.h, fg, { opacity: 0 }))

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${MOCK_WIDTH}" height="${MOCK_HEIGHT}" ` +
    `viewBox="0 0 ${MOCK_WIDTH} ${MOCK_HEIGHT}">${parts.join('')}</svg>`
  )
}
