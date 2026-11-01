import { describe, expect, it } from 'vitest'
import { methodsUsed } from './methodsUsed.js'
import { REFERENCES } from './references.js'

describe('methodsUsed', () => {
  it('lists only the steps a project reached', () => {
    expect(methodsUsed({})).toEqual([])
    const steps = methodsUsed({ detector: 'sift', matcher: 'bruteforce', verifier: 'ransac', sparse: true }).map(
      (m) => m.step,
    )
    expect(steps).toEqual(['Features', 'Matching', 'Verification', 'Structure from motion', 'Lens model'])
  })

  it('cites what ran: the detector, the verifier, the lens model', () => {
    const m = methodsUsed({ detector: 'aliked', matcher: 'lightglue', verifier: 'magsac', sparse: true, fisheye: true })
    const refsOf = (step) => m.find((x) => x.step === step).refs
    expect(refsOf('Features')).toEqual(['zhao2023'])
    expect(refsOf('Matching')).toEqual(['lindenberger2023'])
    expect(refsOf('Verification')).toContain('barath2020')
    expect(refsOf('Lens model')).toEqual(['kannala2006'])
  })

  it('describes the orthophoto from its recorded method', () => {
    const [o] = methodsUsed({
      ortho: { blend: 'mosaic', seamline: 'graphcut', seamBlend: 'multiband', colourBalance: true },
    })
    expect(o.method).toBe('Mosaic: graph-cut seamlines, per-image exposure gains, multiband blending')
    expect(o.refs).toEqual(['boykov2001', 'boykov2004', 'brown2007', 'burt1983'])
    const [f] = methodsUsed({
      ortho: { blend: 'mosaic', seamline: 'nadir', seamBlend: 'feather', colourBalance: false },
    })
    expect(f.refs).toEqual([])
  })

  it('names the co-registration steps that ran', () => {
    const [c] = methodsUsed({ coregistration: { horizontal: true, vertical: true, tilt: 'plane' } })
    expect(c.step).toBe('DEM co-registration')
    expect(c.method).toBe(
      'To a reference DEM on stable ground, as xDEM chains them: horizontal shift (Nuth & Kääb), vertical shift, tilt plane',
    )
    expect(c.refs).toEqual(['nuth2011', 'xdem2026'])
    expect(methodsUsed({ coregistration: { vertical: true, tilt: 'off' } })[0].refs).toEqual(['xdem2026'])
  })

  it('cites only keys the bibliography has', () => {
    const all = methodsUsed({
      detector: 'sift',
      matcher: 'bruteforce',
      verifier: 'magsac',
      sparse: true,
      georef: true,
      dense: true,
      denseViewSelection: 'acmh',
      densePlanarPrior: true,
      denseGeomPass: true,
      mesh: true,
      textured: true,
      dem: true,
      demFill: 'idw',
      groundClassified: true,
      aboveGroundClassified: true,
      ortho: { blend: 'mosaic', seamline: 'graphcut', seamBlend: 'multiband', colourBalance: true },
    })
    for (const m of all) for (const k of m.refs) expect(REFERENCES[k], k).toBeTruthy()
  })
})
