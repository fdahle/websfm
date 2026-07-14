import { describe, it, expect } from 'vitest'
import {
  imageToInputTensor, pointsToModelSpace, bestMaskIndex, logitsToBinaryMask,
  findInput, SAM2_INPUT_SIZE,
} from './sam2.js'

// Build a w×h RGBA buffer from a per-pixel (x,y)→[r,g,b] fn (alpha=255).
function rgba(w, h, fn) {
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y)
      const o = (y * w + x) * 4
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255
    }
  return out
}

const IMAGENET_MEAN = [0.485, 0.456, 0.406]
const IMAGENET_STD = [0.229, 0.224, 0.225]

describe('imageToInputTensor', () => {
  it('produces a CHW Float32Array of length 3·S·S', () => {
    const t = imageToInputTensor(rgba(4, 4, () => [0, 0, 0]), 4, 4, 8)
    expect(t).toBeInstanceOf(Float32Array)
    expect(t.length).toBe(3 * 8 * 8)
  })

  it('ImageNet-normalizes a constant image to a constant per-channel value', () => {
    // Solid mid-grey 128 → normalized (128/255 − mean)/std, same for every pixel.
    const size = 8
    const t = imageToInputTensor(rgba(4, 4, () => [128, 128, 128]), 4, 4, size)
    const plane = size * size
    for (let c = 0; c < 3; c++) {
      const expected = (128 / 255 - IMAGENET_MEAN[c]) / IMAGENET_STD[c]
      for (let i = 0; i < plane; i++) {
        expect(t[c * plane + i]).toBeCloseTo(expected, 5)
      }
    }
  })

  it('lays out channels contiguously (R plane, then G, then B)', () => {
    const size = 4
    // Pure red image: R=255, G=B=0.
    const t = imageToInputTensor(rgba(2, 2, () => [255, 0, 0]), 2, 2, size)
    const plane = size * size
    const rVal = (255 / 255 - IMAGENET_MEAN[0]) / IMAGENET_STD[0]
    const gVal = (0 - IMAGENET_MEAN[1]) / IMAGENET_STD[1]
    const bVal = (0 - IMAGENET_MEAN[2]) / IMAGENET_STD[2]
    expect(t[0]).toBeCloseTo(rVal, 5)          // first R
    expect(t[plane]).toBeCloseTo(gVal, 5)      // first G
    expect(t[2 * plane]).toBeCloseTo(bVal, 5)  // first B (also 0, but its own std)
  })
})

describe('pointsToModelSpace', () => {
  it('scales pixel coords per-axis into S-space and maps labels', () => {
    const pts = [{ x: 100, y: 50, positive: true }, { x: 0, y: 0, positive: false }]
    const { coords, labels } = pointsToModelSpace(pts, 200, 100, 1024)
    expect(coords[0]).toBeCloseTo(100 * 1024 / 200, 4) // 512
    expect(coords[1]).toBeCloseTo(50 * 1024 / 100, 4)  // 512
    expect(coords[2]).toBe(0)
    expect(coords[3]).toBe(0)
    expect(Array.from(labels)).toEqual([1, 0])
  })

  it('defaults an unspecified point to positive (label 1)', () => {
    const { labels } = pointsToModelSpace([{ x: 1, y: 1 }], 10, 10)
    expect(labels[0]).toBe(1)
  })

  it('uses SAM2_INPUT_SIZE by default', () => {
    const { coords } = pointsToModelSpace([{ x: 5, y: 5 }], 10, 10)
    expect(coords[0]).toBeCloseTo(5 * SAM2_INPUT_SIZE / 10, 4)
  })
})

describe('bestMaskIndex', () => {
  it('returns the index of the highest IoU', () => {
    expect(bestMaskIndex([0.1, 0.9, 0.5], 3)).toBe(1)
  })
  it('handles BigInt scores', () => {
    expect(bestMaskIndex([2n, 5n, 1n], 3)).toBe(1)
  })
  it('returns 0 when there are no scores', () => {
    expect(bestMaskIndex(null, 0)).toBe(0)
    expect(bestMaskIndex(undefined, 3)).toBe(0)
  })
})

describe('findInput — decoder input-name resolution', () => {
  // Real input names from onnx-community/sam2-hiera-tiny's
  // prompt_encoder_mask_decoder.onnx (transformers.js export).
  const onnxCommunity = [
    'image_embeddings', 'high_res_feats_0', 'high_res_feats_1',
    'input_points', 'input_labels', 'input_masks', 'has_input_masks',
  ]
  // Meta's own export uses these names — must resolve too.
  const meta = [
    'image_embeddings', 'high_res_feats_0', 'high_res_feats_1',
    'point_coords', 'point_labels', 'mask_input', 'has_mask_input', 'orig_im_size',
  ]

  it('resolves the onnx-community names to the right inputs', () => {
    expect(findInput(onnxCommunity, 'point_label', 'input_label', 'label')).toBe('input_labels')
    expect(findInput(onnxCommunity, 'point_coord', 'input_point', 'coord', 'point')).toBe('input_points')
    const hasMask = findInput(onnxCommunity, 'has_mask', 'has_input_mask', 'has_input', 'has_')
    expect(hasMask).toBe('has_input_masks')
    // Plain mask input must NOT collide with the has-mask flag.
    const maskName = onnxCommunity.find((n) => /mask/i.test(n) && n !== hasMask)
    expect(maskName).toBe('input_masks')
  })

  it('resolves Meta-style names too', () => {
    expect(findInput(meta, 'point_label', 'input_label', 'label')).toBe('point_labels')
    expect(findInput(meta, 'point_coord', 'input_point', 'coord', 'point')).toBe('point_coords')
    const hasMask = findInput(meta, 'has_mask', 'has_input_mask', 'has_input', 'has_')
    expect(hasMask).toBe('has_mask_input')
    const maskName = meta.find((n) => /mask/i.test(n) && n !== hasMask)
    expect(maskName).toBe('mask_input')
    expect(findInput(meta, 'orig_im_size', 'orig')).toBe('orig_im_size')
  })

  it('returns null when no fragment matches', () => {
    expect(findInput(['a', 'b'], 'nope')).toBe(null)
  })
})

describe('logitsToBinaryMask', () => {
  it('thresholds logits at 0 into a 0/1 mask at the target resolution', () => {
    // 2×2 logits: top row positive, bottom row negative.
    const logits = new Float32Array([5, 5, -5, -5])
    const mask = logitsToBinaryMask(logits, 2, 2, 2, 2, 0)
    expect(Array.from(mask)).toEqual([1, 1, 0, 0])
  })

  it('upsamples to the original resolution (length w·h)', () => {
    const logits = new Float32Array([5, 5, 5, 5]) // all inside
    const mask = logitsToBinaryMask(logits, 2, 2, 8, 6)
    expect(mask.length).toBe(8 * 6)
    expect(mask.every((v) => v === 1)).toBe(true)
  })

  it('respects a custom threshold', () => {
    const logits = new Float32Array([1, 1, 1, 1])
    expect(logitsToBinaryMask(logits, 2, 2, 2, 2, 2).every((v) => v === 0)).toBe(true)
    expect(logitsToBinaryMask(logits, 2, 2, 2, 2, 0.5).every((v) => v === 1)).toBe(true)
  })
})
