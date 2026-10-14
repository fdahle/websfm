import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// The worker client and the models store are browser-side; stand them in so the
// sequencing can be driven by hand.
const pending = { encode: [], decode: [] }
vi.mock('../workers/computeClient.js', () => ({
  segmentEncode: vi.fn(() => new Promise((resolve) => pending.encode.push(resolve))),
  segmentDecode: vi.fn((uuid, pts) => new Promise((resolve) => pending.decode.push({ resolve, uuid, pts }))),
  segmentForget: vi.fn(),
}))
vi.mock('../stores/useModelsStore.js', () => ({
  useModelsStore: () => ({ ensureReady: async () => true }),
}))
vi.mock('../core/segment/sam2.js', () => ({
  logitsToBinaryMask: (logits, mw, mh, w, h) => new Uint8Array(w * h).fill(1),
}))

const { segmentDecode, segmentForget } = await import('../workers/computeClient.js')
const { useSmartSelect } = await import('./useSmartSelect.js')

// Minimal OffscreenCanvas for buildMaskCanvas (node has none).
class FakeCanvas {
  constructor(w, h) { this.width = w; this.height = h }
  getContext() {
    return {
      createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: () => {},
    }
  }
}

const tick = () => new Promise((r) => setTimeout(r, 0))
const decodeResult = { logits: new Float32Array(4), mw: 2, mh: 2, iou: 0.9 }

function setup({ uuid = 'u1', native = { width: 4000, height: 3000 } } = {}) {
  const image = { uuid, url: 'blob:full' }
  const s = useSmartSelect({ image: () => image, nativeSize: () => native, drawOverlay: () => {} })
  return { s, image }
}

async function encoded(s) {
  const p = s.ensureEncoded()
  await tick()
  pending.encode.shift()({ width: 1024, height: 768 })
  await p
}

beforeEach(() => {
  pending.encode.length = 0
  pending.decode.length = 0
  vi.clearAllMocks()
  globalThis.OffscreenCanvas = FakeCanvas
})
afterEach(() => { delete globalThis.OffscreenCanvas })

describe('useSmartSelect', () => {
  it('maps NATIVE click pixels to the encoded raster', async () => {
    const { s } = setup()
    await encoded(s)
    s.smartClick(2000, 1500, false)
    await tick()
    expect(segmentDecode).toHaveBeenCalledWith('u1', [{ x: 512, y: 384, positive: true }])
  })

  it('a decode that resolves after discardSmart() does not resurrect the candidate', async () => {
    const { s } = setup()
    await encoded(s)
    const click = s.smartClick(100, 100, false)
    await tick()
    s.discardSmart()                       // Delete pressed while segmenting
    pending.decode.shift().resolve(decodeResult)
    await click
    expect(s.smartHasPreview.value).toBe(false)
    expect(s.smartPreviewCanvas.value).toBeNull()
    expect(s.buildCommitCanvas(4, 3)).toBeNull() // so Enter has nothing to commit
    expect(s.smartStatus.value).toBe('ready — click an object')
  })

  it('a click made after the discard still gets its own segment', async () => {
    const { s } = setup()
    await encoded(s)
    const first = s.smartClick(100, 100, false)
    await tick()
    s.discardSmart()
    s.smartClick(200, 200, false)          // coalesced: re-runs after the in-flight decode
    pending.decode.shift().resolve(decodeResult) // stale (pre-discard)
    await tick()
    expect(s.smartHasPreview.value).toBe(false)
    const next = pending.decode.shift()
    expect(next.pts).toEqual([{ x: 200 * 1024 / 4000, y: 200 * 768 / 3000, positive: true }])
    next.resolve(decodeResult)
    await first
    expect(s.smartHasPreview.value).toBe(true)
    expect(s.buildCommitCanvas(4, 3)).not.toBeNull()
  })

  it('a live decode still shows its preview', async () => {
    const { s } = setup()
    await encoded(s)
    const click = s.smartClick(100, 100, false)
    await tick()
    pending.decode.shift().resolve(decodeResult)
    await click
    expect(s.smartHasPreview.value).toBe(true)
  })

  it('an encode that resolves after resetSmart() is dropped and its embedding freed', async () => {
    const { s } = setup()
    const p = s.ensureEncoded()
    await tick()
    s.resetSmart('u1')                     // image switched mid-encode
    pending.encode.shift()({ width: 1024, height: 768 })
    await p
    expect(s.smartStatus.value).toBe('')
    expect(segmentForget).toHaveBeenCalledTimes(2) // by resetSmart, and again after the late encode
    // Not marked encoded: a click re-encodes instead of decoding a missing embedding.
    s.smartClick(10, 10, false)
    await tick()
    expect(pending.encode.length).toBe(1)
    expect(segmentDecode).not.toHaveBeenCalled()
  })
})
