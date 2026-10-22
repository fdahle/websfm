import { describe, it, expect } from 'vitest'
import { fileSafe, exportFileName, defaultExportName } from './exportNames.js'

describe('fileSafe', () => {
  it('keeps letters of any script, replaces the rest and drops an extension', () => {
    expect(fileSafe('Imported (south.laz)')).toBe('Imported_south')
    expect(fileSafe('  Gletscher Süd 2026 ')).toBe('Gletscher_Süd_2026')
    expect(fileSafe('site.tif')).toBe('site')
    expect(fileSafe('')).toBe('')
  })
})

describe('exportFileName', () => {
  it('takes the typed name, else the default', () => {
    expect(exportFileName('My ortho', 'proj-ortho')).toBe('My_ortho')
    expect(exportFileName('   ', 'proj-ortho')).toBe('proj-ortho')
    expect(exportFileName(undefined, 'proj-ortho')).toBe('proj-ortho')
  })
})

describe('defaultExportName', () => {
  const base = 'proj'
  it('names rasters by product, format and reprojection', () => {
    expect(defaultExportName('dem', { format: 'geotiff', base })).toBe('proj-dem')
    expect(defaultExportName('dem', { format: 'cog', base })).toBe('proj-dem-cog')
    expect(defaultExportName('dem', { format: 'png', base })).toBe('proj-dem-hillshade')
    expect(defaultExportName('ortho', { format: 'png', base })).toBe('proj-ortho')
    expect(defaultExportName('ortho', { format: 'cog', base, crs: 'EPSG:3031' })).toBe('proj-ortho-EPSG3031')
    expect(defaultExportName('clip', { base, product: 'ortho' })).toBe('proj-ortho-clipped')
  })

  it('names interchange exports by format', () => {
    expect(defaultExportName('colmap', { format: 'nvm', base })).toBe('proj')
    expect(defaultExportName('colmap', { format: 'bin', base })).toBe('proj-colmap-bin')
    expect(defaultExportName('model', { format: 'transforms', base })).toBe('proj-transforms')
    expect(defaultExportName('cloud', { format: 'las', base: 'proj-Dense_cloud' })).toBe('proj-Dense_cloud')
  })
})
