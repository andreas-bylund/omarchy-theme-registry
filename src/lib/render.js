import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import { buildMockSvg, MOCK_HEIGHT, MOCK_WIDTH } from './mock.js'

const WEBP = { quality: 82, effort: 5 }

export async function renderMock(palette, outFile) {
  const svg = buildMockSvg(palette)
  await mkdir(path.dirname(outFile), { recursive: true })

  await sharp(Buffer.from(svg))
    .resize(MOCK_WIDTH, MOCK_HEIGHT, { fit: 'fill' })
    .webp(WEBP)
    .toFile(outFile)

  return { width: MOCK_WIDTH, height: MOCK_HEIGHT }
}

/**
 * The same mock, composited over the theme's own wallpaper — a simulated desktop
 * rather than a colour study. Identical chrome in every card keeps the grid
 * comparable while the wallpaper carries what the theme actually feels like.
 *
 * Photos cost roughly ten times a flat mock in bytes, so quality is dialled back
 * a little; at grid size the difference is invisible.
 */
export async function renderComposite(wallpaperFile, palette, outFile) {
  await mkdir(path.dirname(outFile), { recursive: true })

  try {
    const base = await sharp(wallpaperFile, { limitInputPixels: 400_000_000 })
      .rotate()
      .resize(MOCK_WIDTH, MOCK_HEIGHT, { fit: 'cover', position: 'attention' })
      .toBuffer()

    const svg = Buffer.from(buildMockSvg(palette, { overWallpaper: true }))

    await sharp(base)
      .composite([{ input: svg, top: 0, left: 0 }])
      .webp({ quality: 74, effort: 5 })
      .toFile(outFile)

    return { width: MOCK_WIDTH, height: MOCK_HEIGHT }
  } catch (err) {
    // An unreadable wallpaper shouldn't cost the theme its preview — the caller
    // falls back to the flat mock.
    return { error: err.message }
  }
}

/** Downscale an arbitrary user image (wallpaper, screenshot) to a grid-sized thumb. */
export async function renderImage(srcFile, outFile, { width = 640, height = 400 } = {}) {
  await mkdir(path.dirname(outFile), { recursive: true })

  try {
    const info = await sharp(srcFile, { limitInputPixels: 400_000_000 })
      .rotate()
      .resize(width, height, { fit: 'cover', position: 'attention', withoutEnlargement: false })
      .webp(WEBP)
      .toFile(outFile)
    return { width: info.width, height: info.height }
  } catch (err) {
    // A corrupt or exotic image is not a reason to drop an otherwise fine theme.
    return { error: err.message }
  }
}

/** Standalone SVG on disk, handy when debugging the mock without a raster step. */
export async function writeMockSvg(palette, outFile) {
  await mkdir(path.dirname(outFile), { recursive: true })
  await writeFile(outFile, buildMockSvg(palette))
}
