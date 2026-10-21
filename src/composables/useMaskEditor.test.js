import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref, shallowRef, reactive, nextTick, markRaw } from 'vue'

// Smart Select's browser side (worker client, models store, SAM2 maths) is stood
// in exactly as in useSmartSelect.test.js; these tests drive the mask canvas.
vi.mock('../workers/computeClient.js', () => ({
  segmentEncode: vi.fn(() => new Promise(() => {})),
  segmentDecode: vi.fn(() => new Promise(() => {})),
  segmentForget: vi.fn(),
}))
vi.mock('../stores/useModelsStore.js', () => ({
  useModelsStore: () => ({ ensureReady: async () => true }),
}))
vi.mock('../core/segment/sam2.js', () => ({ logitsToBinaryMask: () => new Uint8Array(0) }))

const { useMaskEditor } = await import('./useMaskEditor.js')

// ── A one-bit canvas model ────────────────────────────────────────────────────
// The mask canvas is modelled as "anything excluded or not" (`filled`): enough to
// tell which state won a race. Mask Blobs carry the state they encode. Decodes
// (createImageBitmap) and PNG exports (convertToBlob) resolve by hand, so a test
// can interleave them with edits the way a slow encode would.
let decodes, exportsQ, canvases, blobSeq
class FakeCanvas {
  constructor(w, h) {
    this.width = w
    this.height = h
    this.filled = false
    canvases.push(this)
  }
  getContext() {
    const c = this
    return {
      globalCompositeOperation: 'source-over',
      fillStyle: null,
      clearRect() {
        c.filled = false
      },
      drawImage(src) {
        c.filled = src.filled ?? true
      },
      beginPath() {},
      arc() {},
      fill() {
        c.filled = this.globalCompositeOperation !== 'destination-out'
      },
      fillRect() {
        c.filled = this.globalCompositeOperation !== 'destination-out'
      },
      getImageData(x, y, w, h) {
        const data = new Uint8ClampedArray(w * h * 4)
        if (c.filled) for (let i = 3; i < data.length; i += 4) data[i] = 255
        return { data }
      },
      putImageData(id) {
        c.filled = id.data.some((v, i) => i % 4 === 3 && v > 127)
      },
    }
  }
  convertToBlob() {
    const blob = markRaw({ filled: this.filled, id: ++blobSeq })
    return new Promise((resolve) => exportsQ.push(() => resolve(blob)))
  }
}
// markRaw: like a real Blob (which Vue never proxies), a mask keeps its identity
// through the reactive image record — the echo skip compares identities.
const maskBlob = (filled = true) => markRaw({ filled, id: ++blobSeq })

const saved = {}
beforeEach(() => {
  decodes = []
  exportsQ = []
  canvases = []
  blobSeq = 0
  saved.OffscreenCanvas = globalThis.OffscreenCanvas
  saved.createImageBitmap = globalThis.createImageBitmap
  globalThis.OffscreenCanvas = FakeCanvas
  globalThis.createImageBitmap = vi.fn(
    (blob) => new Promise((resolve) => decodes.push(() => resolve({ filled: blob.filled, close() {} }))),
  )
})
afterEach(() => {
  globalThis.OffscreenCanvas = saved.OffscreenCanvas
  globalThis.createImageBitmap = saved.createImageBitmap
})

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// The viewer around the editor: a 100×50 native image at scale 1, and a parent
// that stores whatever mask it is sent (the store's in-memory update), so the
// echo comes back through `image.mask` like in the app.
function setup({ mask = null, maskEdit = true, preview = false, largeScan = false, size = [100, 50] } = {}) {
  const image = reactive({ uuid: 'u1', mask })
  const edit = ref(maskEdit)
  const frame = shallowRef({
    width: size[0],
    height: size[1],
    naturalWidth: 100,
    naturalHeight: 50,
    bitmapScale: 1,
    preview,
    exact: true,
  })
  const editable = ref(!preview)
  const visible = ref(true)
  const emitted = []
  const emit = vi.fn((name, blob, persist) => {
    emitted.push({ name, blob, persist })
    if (name === 'update-mask') image.mask = blob ? { blob } : null
  })
  const drawOverlay = vi.fn()
  const m = useMaskEditor({
    image: () => image,
    maskEdit: () => edit.value,
    viewport: { scale: ref(1), tx: ref(0), ty: ref(0), frame, editable },
    drawOverlay,
    emit,
    isVisible: () => visible.value,
    largeScan: () => largeScan,
  })
  return { m, image, edit, frame, editable, visible, emitted, emit }
}

// A brush stroke at viewport (x, y), committed; returns the export promise.
function stroke(m, x = 10, y = 10) {
  m.beginStroke(x, y)
  return m.endStroke()
}

describe('useMaskEditor: canvas', () => {
  it('starts armed with the brush when mounted while mask edit is already on', () => {
    expect(setup({ maskEdit: true }).m.tool.value).toBe('brush')
    expect(setup({ maskEdit: false }).m.tool.value).toBe(null)
  })
  it('builds no canvas for a preview frame, a native-sized one for full resolution', async () => {
    const pre = setup({ preview: true })
    pre.m.initMaskCanvas()
    expect(pre.m.canvas()).toBeNull()

    const full = setup({ mask: { blob: maskBlob(true) } })
    full.m.initMaskCanvas()
    expect(full.m.canvas()).toMatchObject({ width: 100, height: 50 })
    expect(decodes).toHaveLength(1) // the stored mask is decoded into it
    decodes[0]()
    await flush()
    expect(full.m.canvas().filled).toBe(true)
    expect(full.m.hasMask.value).toBe(true)
    expect(full.m.maskedAt(5, 5)).toBe(true)
  })

  it('a very large scan gets a reduced canvas: whole-mask actions work, painting does not', async () => {
    // A KH-9-sized scan: its reduced display copy is all the view ever shows.
    const { m, emitted } = setup({ preview: true, largeScan: true, size: [65700, 32900] })
    m.initMaskCanvas()
    expect(m.canvas()).toMatchObject({ width: 8192, height: 4102 })
    expect(stroke(m)).toBeNull() // the pointer router never paints here; nor would a stroke
    const inv = m.invertMask()
    exportsQ.shift()()
    await inv
    expect(emitted).toEqual([{ name: 'update-mask', blob: expect.objectContaining({ filled: true }), persist: false }])
    expect(m.maskedAt(65699, 32899)).toBe(true) // native coords map onto the reduced canvas
    expect(m.canUndo.value).toBe(true)
  })

  it('maskedAt is null without a mask to ask', () => {
    const { m } = setup()
    m.initMaskCanvas()
    expect(m.maskedAt(1, 1)).toBeNull()
  })
})

describe('useMaskEditor: commits and persistence', () => {
  it('defers persisting while editing, and skips re-decoding the echo of its own export', async () => {
    const { m, emitted } = setup()
    m.initMaskCanvas()
    await nextTick()
    const pending = stroke(m)
    expect(m.canUndo.value).toBe(true)
    exportsQ.shift()()
    await pending
    expect(emitted).toEqual([{ name: 'update-mask', blob: expect.objectContaining({ filled: true }), persist: false }])
    await nextTick() // the store echoes the blob back through image.mask
    expect(globalThis.createImageBitmap).not.toHaveBeenCalled()
  })

  it('a stroke entirely outside the image commits nothing', () => {
    const { m, emitted } = setup()
    m.initMaskCanvas()
    m.beginStroke(-500, -500)
    expect(m.isDrawing()).toBe(true)
    expect(m.endStroke()).toBeNull()
    expect(m.isDrawing()).toBe(false)
    expect(m.canUndo.value).toBe(false)
    expect(emitted).toEqual([])
  })

  it('erasing the last excluded pixels commits "no mask", not an empty PNG', async () => {
    const { m, image, emitted } = setup()
    m.initMaskCanvas()
    await nextTick()
    const p = stroke(m)
    exportsQ.shift()()
    await p
    await nextTick()
    m.tool.value = 'erase'
    await nextTick()
    await stroke(m)
    expect(exportsQ).toHaveLength(0) // decided from the canvas, no encode
    expect(emitted.at(-1)).toMatchObject({ blob: null, persist: false })
    expect(image.mask).toBeNull()
    expect(m.hasMask.value).toBe(false)
  })

  it('leaving edit mode flushes the session once, persisted, and disarms the tool', async () => {
    const { m, edit, emitted } = setup({ maskEdit: false })
    edit.value = true
    await nextTick()
    expect(m.tool.value).toBe('brush')
    m.initMaskCanvas()
    const p = stroke(m)
    exportsQ.shift()()
    await p
    await nextTick()
    edit.value = false
    await nextTick()
    expect(m.tool.value).toBeNull()
    expect(emitted.map((e) => e.persist)).toEqual([false, true])
    expect(emitted[1].blob).toBe(emitted[0].blob)
    m.flushMask() // nothing pending any more (e.g. unmount right after)
    expect(emitted).toHaveLength(2)
  })

  it('outside edit mode a clear persists at once', async () => {
    const { m, emitted } = setup({ mask: { blob: maskBlob(true) }, maskEdit: false })
    m.initMaskCanvas()
    decodes.shift()()
    await flush()
    m.clearMask()
    expect(emitted).toEqual([{ name: 'update-mask', blob: null, persist: true }])
    expect(m.canUndo.value).toBe(true)
  })
})

describe('useMaskEditor: races', () => {
  it('an export that resolves after Ctrl+Z is dropped, not re-persisted', async () => {
    const { m, image, emitted } = setup()
    m.initMaskCanvas()
    await nextTick()
    const pending = stroke(m) // export in flight
    m.undoMask() // back to "no mask" before the PNG encoded
    expect(image.mask).toBeNull()
    expect(m.canvas().filled).toBe(false)
    exportsQ.shift()()
    await pending
    await nextTick()
    expect(emitted.map((e) => e.blob)).toEqual([null]) // only the undo's state
    expect(image.mask).toBeNull()
    expect(m.hasMask.value).toBe(false)
    expect(m.canRedo.value).toBe(true)
  })

  it('a decode that resolves after a newer change does not repaint the canvas', async () => {
    const { m, image } = setup()
    m.initMaskCanvas()
    await nextTick()
    image.mask = { blob: maskBlob(true) } // external replace → decode starts
    await nextTick()
    expect(decodes).toHaveLength(1)
    image.mask = null // …and an external clear before it lands
    await nextTick()
    decodes.shift()()
    await flush()
    expect(m.canvas().filled).toBe(false)
    expect(m.hasMask.value).toBe(false)
  })

  it('undo then redo restores the committed states through the store', async () => {
    const { m, image } = setup()
    m.initMaskCanvas()
    await nextTick()
    const p = stroke(m)
    exportsQ.shift()()
    await p
    await nextTick()
    const committed = image.mask.blob
    m.undoMask()
    await nextTick()
    expect(image.mask).toBeNull()
    m.redoMask()
    await nextTick()
    expect(image.mask.blob).toBe(committed)
    decodes.shift()() // the redo decodes the snapshot back into the canvas
    await flush()
    expect(m.canvas().filled).toBe(true)
  })

  it('undo/redo wait for the full-resolution bitmap', () => {
    const { m, editable } = setup()
    m.initMaskCanvas()
    stroke(m)
    editable.value = false
    m.undoMask()
    expect(m.canRedo.value).toBe(false)
  })
})

describe('useMaskEditor: rectangle and invert', () => {
  it('commits a dragged rectangle; a sub-pixel one is a no-op', async () => {
    const { m, emitted } = setup()
    m.initMaskCanvas()
    m.beginRect({ px: 10, py: 10 }, false)
    m.updateRect({ px: 10.5, py: 30 }, false)
    await m.commitRect()
    expect(m.rect()).toBeNull()
    expect(emitted).toEqual([])
    m.beginRect({ px: 10, py: 10 }, false)
    m.updateRect(null, true) // native size unknown mid-drag: corner unchanged
    expect(m.rect()).toMatchObject({ x1: 10, y1: 10, erase: false })
    m.updateRect({ px: 40, py: 30 }, false)
    const p = m.commitRect()
    exportsQ.shift()()
    await p
    expect(emitted).toHaveLength(1)
    expect(m.canvas().filled).toBe(true)
  })

  it('switching tool cancels an in-flight rectangle', async () => {
    const { m } = setup()
    m.initMaskCanvas()
    await nextTick()
    m.tool.value = 'rect'
    await nextTick()
    m.beginRect({ px: 1, py: 1 }, false)
    m.tool.value = 'brush'
    await nextTick()
    expect(m.rect()).toBeNull()
  })

  it('inverting a full mask leaves nothing excluded and commits "no mask"', async () => {
    const { m, emitted } = setup({ mask: { blob: maskBlob(true) } })
    m.initMaskCanvas()
    decodes.shift()()
    await flush()
    await m.invertMask()
    expect(emitted).toEqual([{ name: 'update-mask', blob: null, persist: false }])
    expect(m.hasMask.value).toBe(false)
  })
})

describe('useMaskEditor: keyboard', () => {
  const key = (k, mods = {}) => ({ key: k, target: null, defaultPrevented: false, preventDefault: vi.fn(), ...mods })

  it('switches tools and sizes the brush, consuming the keys', async () => {
    const { m } = setup()
    m.initMaskCanvas()
    const r = key('r')
    m.onKeydown(r)
    expect(m.tool.value).toBe('rect')
    expect(r.preventDefault).toHaveBeenCalled()
    m.onKeydown(key(']'))
    expect(m.brushRadius.value).toBe(24)
    const other = key('q')
    m.onKeydown(other)
    expect(other.preventDefault).not.toHaveBeenCalled()
  })

  it('Ctrl+Z / Ctrl+Shift+Z undo and redo', async () => {
    const { m, image } = setup()
    m.initMaskCanvas()
    await nextTick()
    const p = stroke(m)
    exportsQ.shift()()
    await p
    await nextTick()
    m.onKeydown(key('z', { ctrlKey: true }))
    expect(image.mask).toBeNull()
    m.onKeydown(key('Z', { ctrlKey: true, shiftKey: true }))
    expect(image.mask).not.toBeNull()
  })

  it('ignores keys in a hidden tab, outside edit mode, or already consumed', () => {
    const hidden = setup()
    hidden.visible.value = false
    hidden.m.onKeydown(key('r'))
    expect(hidden.m.tool.value).toBe('brush')

    const off = setup({ maskEdit: false })
    off.m.onKeydown(key('r'))
    expect(off.m.tool.value).toBeNull()

    const consumed = setup()
    consumed.m.onKeydown(key('r', { defaultPrevented: true }))
    expect(consumed.m.tool.value).toBe('brush')
  })
})
