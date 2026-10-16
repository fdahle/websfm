import { describe, it, expect } from 'vitest'
import { detectFileKind, isColmapFile } from './importKind.js'

describe('detectFileKind', () => {
  it('detects COLMAP model files by name (case-insensitive, path-stripped)', () => {
    expect(detectFileKind('anything', 'cameras.txt')).toEqual({ kind: 'colmap', confidence: 'high' })
    expect(detectFileKind('', 'sparse/0/images.bin')).toEqual({ kind: 'colmap', confidence: 'high' })
    expect(detectFileKind('', 'Points3D.TXT')).toEqual({ kind: 'colmap', confidence: 'high' })
    expect(isColmapFile('cameras.txt')).toBe(true)
    expect(isColmapFile('mycameras.txt')).toBe(false)
    expect(isColmapFile('cameras.csv')).toBe(false)
  })

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

  it('detects per-image intrinsics (image column, no ground position) as a sensor file', () => {
    expect(detectFileKind('image,focal,cx,cy\na.tif,3500,2000,1500')).toEqual({ kind: 'sensor', confidence: 'high' })
  })

  it('detects image fiducials with one image per row (marks in scan pixels), not intrinsics', () => {
    const text = 'image_id,corner_top_left_x,corner_top_left_y,corner_top_right_x,corner_top_right_y,'
      + 'corner_bottom_left_x,corner_bottom_left_y,principal_point_x,principal_point_y\n'
      + 'a.tif,329.7,329.7,8809.7,329.7,330.3,8810.3,4569.4,4569.9'
    expect(detectFileKind(text)).toEqual({ kind: 'fiducialObs', confidence: 'high' })
  })

  it('keeps a one-row camera certificate (marks in mm) a sensor file', () => {
    const text = 'focal_length,corner_top_left_x_mm,corner_top_left_y_mm,corner_top_right_x_mm,corner_top_right_y_mm,'
      + 'corner_bottom_left_x_mm,corner_bottom_left_y_mm\n152.865,-106,106,106,106,-106,-106'
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

describe('detectFileKind — image file-name columns', () => {
  it('reads an image_file_name + lon/lat list as camera positions', () => {
    expect(detectFileKind('image_file_name,lon,lat,alt,x_map,y_map\na.tif,-111.7,32.9,3810,432998,3642109').kind).toBe('pose')
  })
  it('reads a point-label column beside image names as ground control', () => {
    expect(detectFileKind('gcp_label,image_file_name,x,y,lon,lat,elev\nG1,a.tif,100,200,-111.7,32.9,400').kind).toBe('gcp')
    expect(detectFileKind('point_label,image_file_name,x,y\nP1,a.tif,100,200').kind).toBe('gcp')
  })
})
