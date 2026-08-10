import { describe, it, expect } from 'vitest'
import { guessMapping, buildPoses } from './pose.js'

describe('guessMapping', () => {
  it('maps standard pose headers', () => {
    const m = guessMapping(
      ['image', 'x', 'y', 'z', 'omega', 'phi', 'kappa'],
      7,
      true,
    )
    expect(m).toMatchObject({
      image: 0, x: 1, y: 2, z: 3, omega: 4, phi: 5, kappa: 6,
    })
  })

  it('recognises orientation aliases (roll/pitch/yaw)', () => {
    const m = guessMapping(
      ['file', 'e', 'n', 'h', 'roll', 'pitch', 'yaw'],
      7,
      true,
    )
    expect(m).toMatchObject({
      image: 0, x: 1, y: 2, z: 3, omega: 4, phi: 5, kappa: 6,
    })
  })

  it('maps accuracy columns', () => {
    const m = guessMapping(
      ['image', 'x', 'y', 'z', 'omega', 'phi', 'kappa', 'accuracy', 'angacc',
        'sigma_x', 'accuracy_y', 'acc_z', 'sigma_omega', 'pitch_accuracy', 'acc_kappa'],
      15,
      true,
    )
    expect(m).toMatchObject({
      accXYZ: 7, accAngle: 8,
      accuracyX: 9, accuracyY: 10, accuracyZ: 11,
      accuracyOmega: 12, accuracyPhi: 13, accuracyKappa: 14,
    })
  })

  it('falls back to positional columns without a header', () => {
    const m = guessMapping([], 7, false)
    expect(m).toMatchObject({
      image: 0, x: 1, y: 2, z: 3, omega: 4, phi: 5, kappa: 6,
    })
    // Accuracy columns are never guessed positionally.
    expect(m.accXYZ).toBeNull()
    expect(m.accAngle).toBeNull()
  })

  it('stops positional fallback at columnCount', () => {
    const m = guessMapping([], 4, false)
    expect(m).toMatchObject({ image: 0, x: 1, y: 2, z: 3, omega: null })
  })
})

describe('buildPoses', () => {
  const mapping = {
    image: 0, x: 1, y: 2, z: 3, omega: 4, phi: 5, kappa: 6,
    accuracyX: null, accuracyY: null, accuracyZ: null, accXYZ: null,
    accuracyOmega: null, accuracyPhi: null, accuracyKappa: null, accAngle: null,
  }

  it('builds numeric poses from valid rows', () => {
    const { poses, skipped } = buildPoses(
      [['img1', '1', '2', '3', '10', '20', '30']],
      mapping,
    )
    expect(skipped).toBe(0)
    expect(poses[0]).toMatchObject({
      imageName: 'img1', x: 1, y: 2, z: 3, omega: 10, phi: 20, kappa: 30,
    })
  })

  it('skips rows without an image name', () => {
    const { poses, skipped } = buildPoses(
      [['', '1', '2', '3', '0', '0', '0']],
      mapping,
    )
    expect(poses).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  it('skips rows without a valid X/Y position', () => {
    const { poses, skipped } = buildPoses(
      [['img', 'oops', '2', '3', '0', '0', '0']],
      mapping,
    )
    expect(poses).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  it('leaves missing angle columns null', () => {
    const noAngles = { ...mapping, omega: null, phi: null, kappa: null }
    const { poses } = buildPoses([['img', '1', '2', '3']], noAngles)
    expect(poses[0]).toMatchObject({
      imageName: 'img', x: 1, y: 2, z: 3, omega: null, phi: null, kappa: null,
    })
  })

  it('lets a later row override an earlier one with the same image name', () => {
    const { poses } = buildPoses(
      [
        ['img', '1', '1', '1', '0', '0', '0'],
        ['img', '9', '9', '9', '1', '2', '3'],
      ],
      mapping,
    )
    expect(poses).toHaveLength(1)
    expect(poses[0]).toMatchObject({ x: 9, y: 9, z: 9, omega: 1 })
  })

  it('passes accuracy columns through when mapped', () => {
    const withAcc = {
      ...mapping, accXYZ: 7, accAngle: 8,
      accuracyX: 9, accuracyY: 10, accuracyZ: 11,
      accuracyOmega: 12, accuracyPhi: 13, accuracyKappa: 14,
    }
    const { poses } = buildPoses(
      [['img', '1', '2', '3', '0', '0', '0', '0.05', '0.5',
        '0.01', '0.02', '0.03', '0.1', '0.2', '0.3']],
      withAcc,
    )
    expect(poses[0]).toMatchObject({
      accXYZ: 0.05, accAngle: 0.5,
      accuracyX: 0.01, accuracyY: 0.02, accuracyZ: 0.03,
      accuracyOmega: 0.1, accuracyPhi: 0.2, accuracyKappa: 0.3,
    })
  })
})
