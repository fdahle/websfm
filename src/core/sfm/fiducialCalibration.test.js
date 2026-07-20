import { describe,expect,it } from 'vitest'
import { applyFiducialTransform, estimateBatchFiducialLayout, fitFiducialTransform, invertFiducialTransform, validateFiducialCalibration } from './fiducialCalibration.js'

const points=[{px:0,py:0},{px:100,py:0},{px:100,py:80},{px:0,py:80},{px:50,py:40}]
const truth=(p)=>({x:0.014*p.px+0.001*p.py-1,y:-0.002*p.px+0.015*p.py+2})
const pairs=points.map(p=>({...p,xMm:truth(p).x,yMm:truth(p).y}))

describe('fiducial calibration',()=>{
  it('fits affine and round-trips its inverse',()=>{
    const fit=fitFiducialTransform(pairs,'affine'); expect(fit.rmsUm).toBeLessThan(1e-6)
    const q=applyFiducialTransform({x:20,y:30},fit),p=invertFiducialTransform(q,fit)
    expect(p.x).toBeCloseTo(20,8);expect(p.y).toBeCloseTo(30,8)
  })
  it('fits conformal and projective models',()=>{
    const sim=points.slice(0,4).map(p=>({...p,xMm:.02*p.px-.003*p.py+4,yMm:.003*p.px+.02*p.py-2}))
    expect(fitFiducialTransform(sim,'conformal').rmsUm).toBeLessThan(1e-5)
    const proj=points.map(p=>{const w=1+.0002*p.px;return{...p,xMm:(.02*p.px+2)/w,yMm:(.018*p.py-1)/w}})
    expect(fitFiducialTransform(proj,'projective').rmsUm).toBeLessThan(1e-4)
  })
  it('validates certificate mapping without modifying detections',()=>{
    const image={id:'i',fiducialDetections:pairs.slice(0,4).map((p,i)=>({slot:`s${i}`,px:p.px,py:p.py}))}
    const cal={transform:'affine',slotMap:{s0:'m0',s1:'m1',s2:'m2',s3:'m3'},marks:pairs.slice(0,4).map((p,i)=>({id:`m${i}`,xMm:p.xMm,yMm:p.yMm}))}
    expect(validateFiducialCalibration([image],cal).failed).toBe(0)
  })
  it('estimates a centred metric layout from known scan pitch',()=>{
    const images=[{fiducialDetections:[{slot:'a',px:0,py:0},{slot:'b',px:100,py:0},{slot:'c',px:0,py:100}]}]
    const cal=estimateBatchFiducialLayout(images,.01)
    expect(cal.method).toBe('batch');expect(cal.marks).toHaveLength(3)
  })
})
