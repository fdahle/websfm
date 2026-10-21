import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { ref, reactive, nextTick } from 'vue'
import { useImageViewport } from './useImageViewport.js'

// The viewport's DOM is three numbers here: the container's client size, its
// client rect origin, and the <img>'s bitmap size. ResizeObserver is stood in so
// the test can fire it.
let observers
class FakeResizeObserver {
  constructor(cb) {
    this.cb = cb
    this.observed = []
    observers.push(this)
  }
  observe(el) {
    this.observed.push(el)
  }
  disconnect() {
    this.disconnected = true
  }
}
let savedRO
beforeEach(() => {
  observers = []
  savedRO = globalThis.ResizeObserver
  globalThis.ResizeObserver = FakeResizeObserver
})
afterEach(() => {
  globalThis.ResizeObserver = savedRO
})

function setup({ natural = [1000, 500], meta = [1000, 500], box = [500, 500], lowRes = false } = {}) {
  const el = { clientWidth: box[0], clientHeight: box[1], getBoundingClientRect: () => ({ left: 100, top: 50 }) }
  const container = ref(el)
  const imgEl = ref({ naturalWidth: natural[0], naturalHeight: natural[1] })
  const image = reactive({
    url: lowRes ? 'blob:preview' : 'blob:full',
    lowResUrl: lowRes ? 'blob:preview' : null,
    meta: meta ? { width: meta[0], height: meta[1] } : null,
  })
  const onViewChange = vi.fn()
  const onFrameChange = vi.fn()
  const v = useImageViewport({ container, imgEl, image: () => image, onViewChange, onFrameChange })
  return { v, el, imgEl, image, onViewChange, onFrameChange }
}

describe('useImageViewport', () => {
  it('fits a loaded image into the viewport, centred, and reveals it', () => {
    const { v, onViewChange } = setup()
    expect(v.fit()).toBe(false) // no frame before the bitmap loaded
    v.refreshFrame()
    expect(v.fit()).toBe(true)
    expect([v.scale.value, v.tx.value, v.ty.value]).toEqual([0.5, 0, 125])
    expect(v.imageReady.value).toBe(true)
    expect(v.editable.value).toBe(true)
    expect(onViewChange).toHaveBeenCalledTimes(1)
  })

  it('defers the fit in a 0×0 (hidden) tab and fits once the ResizeObserver sees a size', () => {
    const { v, el } = setup({ box: [0, 0] })
    v.observeResize()
    v.refreshFrame()
    expect(v.fit()).toBe(false)
    expect(v.imageReady.value).toBe(false)
    expect(v.scale.value).toBe(1) // never 0
    const ro = observers[0]
    expect(ro.observed).toEqual([el])
    ro.cb() // still 0×0: nothing
    expect(v.imageReady.value).toBe(false)
    el.clientWidth = 500
    el.clientHeight = 500
    ro.cb()
    expect(v.imageReady.value).toBe(true)
    expect(v.scale.value).toBe(0.5)
    v.disconnectResize()
    expect(ro.disconnected).toBe(true)
  })

  it("keeps the user's zoom when a tab springs back to the size it was fitted at", () => {
    const { v, el } = setup()
    v.observeResize()
    v.refreshFrame()
    v.fit()
    v.zoomIn()
    const zoomed = v.scale.value
    el.clientWidth = 0
    el.clientHeight = 0 // hidden
    observers[0].cb()
    el.clientWidth = 500
    el.clientHeight = 500 // shown again
    observers[0].cb()
    expect(v.scale.value).toBe(zoomed)
    el.clientWidth = 1000 // a real resize refits
    observers[0].cb()
    expect(v.scale.value).toBe(1)
  })

  it('zooms about a viewport point, and maps the event position to native pixels', () => {
    const { v } = setup()
    v.refreshFrame()
    v.fit()
    const before = v.toImagePixel(250, 250)
    v.zoomAt(2, 250, 250)
    expect(v.toImagePixel(250, 250)).toEqual(before)
    expect(v.getViewportCoords({ clientX: 350, clientY: 300 })).toEqual({ x: 250, y: 250 })
  })

  it('works in native pixels over a preview, and stays read-only until full resolution', () => {
    const { v } = setup({ natural: [100, 50], meta: [1000, 500], lowRes: true })
    v.refreshFrame()
    v.fit()
    expect(v.frame.value).toMatchObject({ width: 1000, height: 500, preview: true })
    expect(v.scale.value).toBe(0.5)
    expect(v.editable.value).toBe(false)
    expect(v.toImagePixel(500, 375)).toEqual({ px: 1000, py: 500 })
  })

  it('a new url hides the frame until the new bitmap loads', async () => {
    const { v, image } = setup()
    v.refreshFrame()
    v.fit()
    image.url = 'blob:other'
    await nextTick()
    expect(v.frame.value).toBeNull()
    expect(v.imageReady.value).toBe(false)
    expect(v.editable.value).toBe(false)
  })

  it('late metadata re-derives the frame, refits and reports it; an unchanged one does not', async () => {
    const { v, image, onFrameChange } = setup({ natural: [100, 50], meta: null, lowRes: true })
    v.refreshFrame()
    v.fit()
    expect(v.frame.value).toMatchObject({ width: 100, exact: false })
    expect(v.toImagePixel(10, 10)).toBeNull() // native size unknown: no coordinates
    image.meta = { width: 1000, height: 500 }
    await nextTick()
    expect(v.frame.value).toMatchObject({ width: 1000, height: 500, exact: true })
    expect(v.scale.value).toBe(0.5)
    expect(onFrameChange).toHaveBeenCalledTimes(1)
    image.meta = { width: 1000, height: 500 } // same size again
    await nextTick()
    expect(onFrameChange).toHaveBeenCalledTimes(1)
  })

  it('ignores metadata before any bitmap has loaded', async () => {
    const { v, image, onFrameChange } = setup({ meta: null })
    image.meta = { width: 1000, height: 500 }
    await nextTick()
    expect(v.frame.value).toBeNull()
    expect(onFrameChange).not.toHaveBeenCalled()
  })
})
