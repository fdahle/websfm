import { describe, it, expect } from 'vitest'
import { SHORT_MAX, withShorts } from './format.js'
import { sparseShorts } from './sparse.js'
import { denseShorts } from './dense.js'
import { demShorts, orthoShorts } from './raster.js'
import { meshShorts } from './mesh.js'
import { textureShorts } from './texture.js'
import { filterCloudShorts } from './filterCloud.js'
import { classifyGroundShorts } from './classifyGround.js'
import { cleanMeshShorts } from './cleanMesh.js'
import { smoothMeshShorts } from './smoothMesh.js'
import { alignIcpShorts } from './alignIcp.js'
import { fiducialDetectShorts } from './fiducialDetect.js'
import { contoursShorts } from './contours.js'
import { outputEffect } from './output.js'
import {
  RECONSTRUCT_DEFAULTS,
  DENSE_FUSE_DEFAULTS,
  DEM_DEFAULTS,
  ORTHO_DEFAULTS,
  MESH_DEFAULTS,
  TEXTURE_DEFAULTS,
  FILTER_CLOUD_DEFAULTS,
  CLASSIFY_DEFAULTS,
  GROUND_DEFAULTS,
  CLEAN_MESH_DEFAULTS,
  SMOOTH_MESH_DEFAULTS,
  ICP_DEFAULTS,
  CONTOUR_DEFAULTS,
} from '../defaults.user.js'

// The short facts of a processing dialog's step chain (dev plan ▸ dialog layout): one
// chip each, so a few words, never a sentence.
const estimate = { width: 8452, height: 6120, gsd: 0.0312, approx: true }
const SHORTS = {
  sparse: sparseShorts(RECONSTRUCT_DEFAULTS, {
    linkedImages: 347,
    pairs: 5210,
    timedImages: 347,
    rigs: [{ captures: 556 }],
  }),
  dense: denseShorts(DENSE_FUSE_DEFAULTS, { maps: 347 }),
  dem: demShorts(DEM_DEFAULTS, { source: { count: 1e6 }, estimate, unit: 'm' }),
  ortho: orthoShorts(ORTHO_DEFAULTS, { surface: { available: true, label: 'DEM' }, estimate, unit: 'm' }),
  mesh: meshShorts(MESH_DEFAULTS, {
    source: { name: 'Dense', count: 1e6 },
    basis: { count: 1e6, spacing: 0.01, extent: 10 },
  }),
  texture: textureShorts(TEXTURE_DEFAULTS, { cameras: 347 }),
  filter: filterCloudShorts(
    { ...FILTER_CLOUD_DEFAULTS, methods: ['range', 'voxel', 'isolated', 'sor'], zMin: 12.5, zMax: 380 },
    { mergeCell: 0.05 },
  ),
  classify: classifyGroundShorts({ ...GROUND_DEFAULTS, ...CLASSIFY_DEFAULTS }),
  clean: cleanMeshShorts({ ...CLEAN_MESH_DEFAULTS, methods: ['weld', 'components', 'longEdges', 'holes', 'compact'] }),
  smooth: smoothMeshShorts(SMOOTH_MESH_DEFAULTS),
  align: alignIcpShorts(ICP_DEFAULTS, { autoRadius: 0.42, unit: 'm' }),
  fiducial: fiducialDetectShorts(
    { positions: 'corners+sides', polarity: 'auto', overwrite: false, generateMasks: true },
    { images: 84 },
  ),
  contours: contoursShorts(CONTOUR_DEFAULTS, { interval: 2, levels: 48, unit: 'm', onMap: true }),
}

describe('step chain facts', () => {
  it('stay a few words: every short fact fits one chip', () => {
    for (const [dialog, shorts] of Object.entries(SHORTS))
      for (const [step, short] of Object.entries(shorts)) {
        expect(typeof short, `${dialog}.${step}`).toBe('string')
        expect(short.length, `${dialog}.${step}: "${short}"`).toBeLessThanOrEqual(SHORT_MAX)
        expect(short, `${dialog}.${step}`).not.toMatch(/\.$/)
      }
  })
  it('state the numbers a run uses', () => {
    expect(SHORTS.sparse).toEqual({
      register: '347 images · 4 px',
      ba: '≤ 30 iterations',
      calibration: 'auto',
      rollingShutter: 'off',
      cameraRig: '556 captures',
    })
    expect(SHORTS.dense.sample).toBe('every pixel')
    expect(SHORTS.dem.grid).toBe('≈ 8,452 × 6,120 px · 0.0312 m')
    expect(SHORTS.ortho.blend).toBe('mosaic · graph cut · multiband')
    // 10 / (8 · 0.01) = 125 ≈ 2^7 leaves a side; 1.6 · 128² ≈ 26 k triangles
    expect(SHORTS.mesh.solve).toBe('depth 7 (auto) · ≈ 26 k triangles')
    expect(SHORTS.contours.levels).toBe('48 levels · every 2 m')
    expect(denseShorts({ ...DENSE_FUSE_DEFAULTS, removeIsolated: false }, { maps: 2 }).isolated).toBe('off')
    expect(sparseShorts({ ...RECONSTRUCT_DEFAULTS, addToModel: true }, { newImages: 12 }).register).toBe(
      '12 new images',
    )
  })
  it('pairs long effects with their facts, leaving other lines as they are', () => {
    expect(withShorts({ a: 'Long a.', warn: 'Careful.' }, { a: 'a' })).toEqual({
      a: { short: 'a', long: 'Long a.' },
      warn: 'Careful.',
    })
    expect(outputEffect(false, { main: 'DEM', replaceable: true, newName: 'DEM 2' }, 'DEM').short).toBe('adds "DEM 2"')
  })
})
