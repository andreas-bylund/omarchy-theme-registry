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
