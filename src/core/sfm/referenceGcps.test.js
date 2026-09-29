import { expect, it } from 'vitest'
import { referenceGcpCandidates } from './referenceGcps.js'
function fixture() {
  return {
    points: [{ x: 20.5, y: 69.5, z: 0, viewsPx: new Map([['a',[11,12]],['b',[13,14]]]) }],
    images: [{ uuid: 'a', name: 'a.jpg', toScan: (x,y) => ({ x:x+100, y:y+200 }) }, { uuid: 'b', name: 'b.jpg' }],
    ortho: { width: 100, height: 100, originX: 0, originY: 100, gsd: 1, frame: { kind: 'local', origin: [0,0,0], east:[1,0,0], north:[0,1,0], up:[0,0,1] } },
    reference: { geoTransform: { originX: 1000, originY: 2000, scaleX: 2, scaleY: -2 } },
    matches: [{ a:[20,30], b:[25,35] }], H: [1,0,5,0,1,5,0,0,1], localWidth:100, localHeight:100,
    referenceLayout: { width:100, height:100, col:0, row:0, scaleX:1, scaleY:1 },
  }
}
it('maps a verified local match to reference coordinates and original photo measurements', () => {
  const result = referenceGcpCandidates(fixture())
  expect(result).toHaveLength(1)
  expect(result[0]).toMatchObject({ x:1051, y:1929, z:null, offsetPx:0, observations: [{ imageName:'a.jpg', px:111, py:212 }, { imageName:'b.jpg', px:13, py:14 }] })
})
it('never invents image observations or accepts distant tracks', () => {
  const f = fixture(); f.images.pop()
  expect(referenceGcpCandidates(f)).toEqual([])
  f.images.push({ uuid:'b', name:'b.jpg' }); f.matches[0].a = [70,80]
  expect(referenceGcpCandidates(f)).toEqual([])
})
