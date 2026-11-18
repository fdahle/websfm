// A canvas whose pixels are read back (encoded to a file, probed, measured) is
// CPU-backed: getContext('2d', { willReadFrequently: true }). With a GPU-backed canvas,
// Chrome on Linux with Vulkan read back all black: every thumbnail of a project came out
// black, and video frames, masks and Evaluate's images would too (2026-11-18, headed
// Chrome with --enable-features=Vulkan; a red canvas encoded and decoded as 0, 0, 0). In
// a file that reads a canvas back, every 2D context asks for it, but the on-screen ones
// named below, which are only drawn.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const root = new URL('../../', import.meta.url)
const READBACK = /\b(convertToBlob|toBlob|getImageData|toDataURL)\(/
const PLAIN_2D = /getContext\('2d'\)/g
// On-screen canvases in a file that also reads another back: drawn, never read.
const ON_SCREEN = {
  'src/composables/useDepthOverlay.js': 4, // the overlay drawn over the image
}

describe('canvases that are read back', () => {
  it('are CPU-backed (willReadFrequently), so a GPU canvas cannot read back black', () => {
    const files = execFileSync('git', ['ls-files', 'src/**/*.js', 'src/**/*.vue'], { cwd: root, encoding: 'utf8' })
      .trim()
      .split('\n')
      .filter((f) => !f.includes('.test.'))
    const found = []
    for (const f of files) {
      const src = readFileSync(new URL(f, root), 'utf8')
      if (!READBACK.test(src)) continue
      const plain = (src.match(PLAIN_2D) ?? []).length
      if (plain > (ON_SCREEN[f] ?? 0)) found.push(`${f}: ${plain} getContext('2d') without willReadFrequently`)
    }
    expect(found).toEqual([])
  })
})
