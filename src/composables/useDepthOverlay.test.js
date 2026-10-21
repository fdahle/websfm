import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { reactive, shallowRef, nextTick } from 'vue'
import { useDepthOverlay } from './useDepthOverlay.js'

// Node has no canvas: a fake OffscreenCanvas records what was drawn last, and
// createImageBitmap resolves when the test says so — so decode order is controlled.
let decodes
beforeEach(() => {
  decodes = []
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w
      this.height = h
      this.drawn = null
    }
    getContext() {
      return {
        clearRect: () => {
          this.drawn = null
        },
        drawImage: (bmp) => {
          this.drawn = bmp.src
        },
      }
    }
  }
  globalThis.createImageBitmap = (blob) => new Promise((resolve) => decodes.push(() => resolve({ src: blob.id })))
})
afterEach(() => {
  delete globalThis.OffscreenCanvas
  delete globalThis.createImageBitmap
})

function setup() {
  const image = reactive({ depth: null })
  const frame = shallowRef({ width: 4, height: 3, preview: false })
  const overlay = useDepthOverlay({ frame, image: () => image, drawOverlay: vi.fn(), emit: vi.fn() })
  overlay.initDepthCanvas()
  return { image, overlay }
}

describe('useDepthOverlay: latest wins', () => {
  it('ignores an older decode that resolves after a newer one', async () => {
    const { image, overlay } = setup()
    image.depth = { blob: { id: 'old' } }
    await nextTick()
    image.depth = { blob: { id: 'new' } }
    await nextTick()
    decodes[1]()
    await Promise.resolve()
    await Promise.resolve()
    decodes[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.depthCanvas.value.drawn).toBe('new')
  })

  it('does not repaint a decode that lands after the depth map was cleared', async () => {
    const { image, overlay } = setup()
    image.depth = { blob: { id: 'a' } }
    await nextTick()
    image.depth = null
    await nextTick()
    decodes[0]()
    await Promise.resolve()
    await Promise.resolve()
    expect(overlay.depthCanvas.value.drawn).toBe(null)
    expect(overlay.hasDepth.value).toBe(false)
  })
})
