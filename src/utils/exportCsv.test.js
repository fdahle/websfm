import { describe, expect, it } from 'vitest'
import { buildPosesCsv } from './exportCsv.js'

describe('buildPosesCsv', () => {
  it('exports per-axis position and orientation accuracies', () => {
    const csv = buildPosesCsv([{
      imageName: 'survey.jpg', x: 1, y: 2, z: 3,
      omega: 4, phi: 5, kappa: 6,
      accuracyX: 0.01, accuracyY: 0.02, accuracyZ: 0.03,
      accuracyOmega: 0.1, accuracyPhi: 0.2, accuracyKappa: 0.3,
    }], 'EPSG:32632')

    expect(csv).toBe(
      'image,X,Y,Z,omega,phi,kappa,accuracy_x,accuracy_y,accuracy_z,'
      + 'accuracy_omega,accuracy_phi,accuracy_kappa,crs\r\n'
      + 'survey.jpg,1,2,3,4,5,6,0.01,0.02,0.03,0.1,0.2,0.3,EPSG:32632\r\n',
    )
  })

  it('exports legacy scalar accuracies as axis fallbacks', () => {
    const csv = buildPosesCsv([{
      imageName: 'legacy.jpg', x: 1, y: 2, z: 3,
      omega: null, phi: null, kappa: null, accXYZ: 5, accAngle: 2,
    }], 'EPSG:32632')

    expect(csv).toContain('legacy.jpg,1,2,3,,,,5,5,5,2,2,2,EPSG:32632')
  })
})
