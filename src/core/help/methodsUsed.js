// The published methods one project's run used, for the Quality Report's "Methods and
// references" section — what a methods section of a paper would cite. Pure: the
// composable (useQualityReport.js) reads the project's state into the flags below.
//
// Each step names what WebSfM ran and the keys of core/help/references.js it follows;
// a step the project has not reached is left out.

const DETECTORS = {
  sift: { method: 'SIFT keypoints, RootSIFT descriptors', refs: ['lowe2004', 'arandjelovic2012'] },
  superpoint: { method: 'SuperPoint', refs: ['detone2018'] },
  disk: { method: 'DISK', refs: ['tyszkiewicz2020'] },
  aliked: { method: 'ALIKED', refs: ['zhao2023'] },
}

/**
 * @param {{
 *   detector?: string|null, matcher?: string|null, verifier?: string|null,
 *   sparse?: boolean, fisheye?: boolean, georef?: boolean, dense?: boolean,
 *   denseViewSelection?: string|null, densePlanarPrior?: boolean, denseGeomPass?: boolean,
 *   mesh?: boolean, textured?: boolean, dem?: boolean, demFill?: string|null,
 *   ortho?: { blend?: string, seamline?: string, seamBlend?: string, colourBalance?: boolean }|null,
 *   groundClassified?: boolean,
 * }} f
 * @returns {{ step: string, method: string, refs: string[] }[]}
 */
export function methodsUsed(f = {}) {
  const out = []
  const det = DETECTORS[f.detector]
  if (det) out.push({ step: 'Features', ...det })
  if (f.matcher) {
    const lg = f.matcher === 'lightglue'
    out.push({
      step: 'Matching',
      method: lg ? 'LightGlue' : 'Nearest-neighbour matching with the ratio test',
      refs: lg ? ['lindenberger2023'] : ['lowe2004'],
    })
    out.push({
      step: 'Verification',
      method:
        f.verifier === 'magsac'
          ? 'MAGSAC++ on the fundamental matrix (normalised eight-point)'
          : 'RANSAC on the fundamental matrix (normalised eight-point)',
      refs: [f.verifier === 'magsac' ? 'barath2020' : 'fischler1981', 'hartley1997'],
    })
  }
  if (f.sparse) {
    out.push({
      step: 'Structure from motion',
      method:
        'Incremental SfM: five-point initial pair, P3P registration, bundle adjustment ' +
        '(Levenberg–Marquardt, Schur complement, preconditioned conjugate gradients)',
      refs: [
        'schonberger2016',
        'nister2004',
        'stewenius2006',
        'persson2018',
        'triggs2000',
        'agarwal2010',
        'hartley2004',
      ],
    })
    out.push({
      step: 'Lens model',
      method: f.fisheye ? 'Kannala–Brandt fisheye' : 'Brown–Conrady radial and tangential distortion',
      refs: [f.fisheye ? 'kannala2006' : 'brown1966'],
    })
  }
  if (f.georef)
    out.push({ step: 'Georeferencing', method: 'Similarity from control (unit quaternions)', refs: ['horn1987'] })
  if (f.dense) {
    const acmh = f.denseViewSelection === 'acmh'
    out.push({
      step: 'Depth maps and fusion',
      method:
        'Slanted-plane PatchMatch with bilateral-weighted NCC, ' +
        (acmh
          ? 'adaptive checkerboard sampling and multi-hypothesis joint view selection (ACMH), '
          : 'checkerboard propagation, ') +
        (f.densePlanarPrior ? 'planar priors from triangulated support points (ACMP), ' : '') +
        (f.denseGeomPass ? 'a geometric-consistency pass, ' : '') +
        'cross-view geometric filtering and fusion',
      refs: [
        'bleyer2011',
        'galliani2015',
        'schonberger2016b',
        ...(acmh ? ['xu2019'] : []),
        ...(f.densePlanarPrior ? ['xu2020'] : []),
      ],
    })
  }
  if (f.groundClassified)
    out.push({ step: 'Ground classification', method: 'Cloth simulation filter', refs: ['zhang2016'] })
  if (f.mesh) out.push({ step: 'Mesh', method: 'Screened Poisson surface reconstruction', refs: ['kazhdan2013'] })
  if (f.textured) {
    out.push({
      step: 'Texture',
      method: 'View selection by a Markov random field, global seam levelling',
      refs: ['waechter2014'],
    })
  }
  if (f.dem && f.demFill === 'idw') {
    out.push({ step: 'DEM', method: 'Gaps filled by inverse-distance weighting', refs: ['shepard1968'] })
  }
  if (f.ortho) {
    const o = f.ortho
    if (o.blend && o.blend !== 'mosaic') {
      out.push({ step: 'Orthophoto', method: `Photos blended per pixel (${o.blend})`, refs: [] })
    } else {
      const parts = [],
        refs = []
      if (o.seamline === 'graphcut') {
        parts.push('graph-cut seamlines')
        refs.push('boykov2001', 'boykov2004')
      } else if (o.seamline) parts.push(`${o.seamline} seamlines`)
      if (o.colourBalance) {
        parts.push('per-image exposure gains')
        refs.push('brown2007')
      }
      if (o.seamBlend === 'multiband') {
        parts.push('multiband blending')
        refs.push('burt1983')
      } else if (o.seamBlend) parts.push(`${o.seamBlend} seams`)
      out.push({ step: 'Orthophoto', method: `Mosaic: ${parts.join(', ') || 'one photo per area'}`, refs })
    }
  }
  return out
}
