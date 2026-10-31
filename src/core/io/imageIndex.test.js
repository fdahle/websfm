import { describe, it, expect } from 'vitest'
import { imageIndexCsv } from './imageIndex.js'

describe('imageIndexCsv', () => {
  it('lists each stored file with its label and original name, in list order', () => {
    const csv = imageIndexCsv([
      { uuid: 'b2', name: 'north', sourceName: 'DSC_0002.JPG' },
      { uuid: 'a1', name: 'DSC_0001.JPG' },
    ])
    expect(csv).toBe('file,name,original_name\nb2,north,DSC_0002.JPG\na1,DSC_0001.JPG,DSC_0001.JPG\n')
  })

  it('quotes a name holding a comma, quote or line break', () => {
    const csv = imageIndexCsv([{ uuid: 'u', name: 'a,b', sourceName: 'say "hi".jpg' }])
    expect(csv.split('\n')[1]).toBe('u,"a,b","say ""hi"".jpg"')
  })

  it('is just the header for a project without images', () => {
    expect(imageIndexCsv([])).toBe('file,name,original_name\n')
  })
})
