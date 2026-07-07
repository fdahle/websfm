import { describe, it, expect } from 'vitest'
import { detectFileKind } from './importKind.js'

describe('detectFileKind', () => {
  it('routes a GeoJSON point file to gcp', () => {
    const text = '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Point","coordinates":[1,2]},"properties":{}}]}'
    expect(detectFileKind(text, 'pts.geojson')).toEqual({ kind: 'gcp', confidence: 'high' })
  })

  it('routes a GeoJSON polygon file to footprint', () => {
    const text = '{"type":"FeatureCollection","features":[{"type":"Feature","geometry":{"type":"Polygon","coordinates":[[[0,0],[1,0],[1,1],[0,0]]]},"properties":{}}]}'
    expect(detectFileKind(text, 'fp.geojson')).toEqual({ kind: 'footprint', confidence: 'high' })
  })

  it('detects a GCP file by pixel-observation columns', () => {
    const text = 'name,x,y,z,image,col,row\nA,1,2,3,img.jpg,100,200'
    expect(detectFileKind(text)).toEqual({ kind: 'gcp', confidence: 'high' })
  })

  it('detects a pose file by orientation columns', () => {
    const text = 'image,x,y,z,omega,phi,kappa\nimg1,1,2,3,10,20,30'
    expect(detectFileKind(text)).toEqual({ kind: 'pose', confidence: 'high' })
  })

  it('detects a sensor file by intrinsics with no per-row image name', () => {
    const text = 'camera,width,height,focal,cx,cy,k1\nCamA,4000,3000,3500,2000,1500,0.01'
    expect(detectFileKind(text)).toEqual({ kind: 'sensor', confidence: 'high' })
  })

  it('leans low-confidence gcp on a name header + bare coordinates', () => {
    const text = 'gcp,x,y,z\nA,1,2,3'
    expect(detectFileKind(text)).toEqual({ kind: 'gcp', confidence: 'low' })
  })

  it('leans low-confidence pose on an image header + bare coordinates', () => {
    const text = 'photo,x,y,z\nimg1,1,2,3'
    expect(detectFileKind(text)).toEqual({ kind: 'pose', confidence: 'low' })
  })

  it('reports ambiguous on empty input', () => {
    expect(detectFileKind('')).toEqual({ kind: 'ambiguous', confidence: 'low' })
  })

  it('reports ambiguous when no signal points either way', () => {
    const text = 'label,x,y,z\nA,1,2,3'
    expect(detectFileKind(text)).toEqual({ kind: 'ambiguous', confidence: 'low' })
  })
})
