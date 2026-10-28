import { describe, expect, it } from 'vitest'
import { outputEffect } from './output.js'

describe('outputEffect', () => {
  it('is inactive for the first product of its kind', () => {
    expect(outputEffect(false, { main: null, replaceable: false, newName: 'DEM' }, 'DEM')).toEqual({
      effect: 'The first DEM: "DEM"',
      inactive: true,
    })
  })

  it('adds beside the main one by default', () => {
    const plan = { main: 'DEM', replaceable: true, newName: 'DEM 2' }
    expect(outputEffect(false, plan, 'DEM').effect).toBe('Adds "DEM 2" as the main DEM; "DEM" stays')
  })

  it('replaces the main one when asked and allowed', () => {
    const plan = { main: 'Dense cloud', replaceable: true, newName: 'Dense cloud 2' }
    expect(outputEffect(true, plan, 'dense cloud').effect).toBe(
      'Replaces "Dense cloud"; products built on it are kept, marked outdated',
    )
  })

  it('never replaces an imported or derived main one', () => {
    const plan = { main: 'Survey', replaceable: false, newName: 'Dense cloud' }
    expect(outputEffect(true, plan, 'dense cloud').effect).toBe(
      '"Survey" is not one the pipeline built, so it stays: adds "Dense cloud" as the main dense cloud',
    )
  })
})
