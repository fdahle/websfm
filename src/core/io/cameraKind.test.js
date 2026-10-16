import { describe, it, expect } from 'vitest'
import { detectCameraMode } from './cameraKind.js'

describe('detectCameraMode', () => {
  it('detects a pose file by image name + orientation columns', () => {
    const text = 'image,x,y,z,omega,phi,kappa\nimg1,1,2,3,10,20,30'
    expect(detectCameraMode(text)).toBe('pose')
  })

  it('detects a sensor file by intrinsics with no per-row image name', () => {
    const text = 'camera,width,height,focal,cx,cy,k1\nCamA,4000,3000,3500,2000,1500,0.01'
    expect(detectCameraMode(text)).toBe('sensor')
  })

  it('detects per-image intrinsics (image column, no positions) as a sensor file', () => {
    expect(detectCameraMode('image,focal,cx,cy\na.tif,3500,2000,1500')).toBe('sensor')
  })

  it('detects a one-row film calibration as a sensor file', () => {
    expect(detectCameraMode('focal_length,pixel_pitch,principal_point_x_mm\n152.865,0.025,-0.03')).toBe('sensor')
  })

  it('defaults to pose on empty input', () => {
    expect(detectCameraMode('')).toBe('pose')
  })

  it('defaults to pose when the signal is inconclusive', () => {
    const text = 'label,x,y,z\nA,1,2,3'
    expect(detectCameraMode(text)).toBe('pose')
  })

  it('prefers pose when a file has both an image name and intrinsics', () => {
    const text = 'image,x,y,z,omega,phi,kappa,focal\nimg1,1,2,3,10,20,30,3500'
    expect(detectCameraMode(text)).toBe('pose')
  })
})
