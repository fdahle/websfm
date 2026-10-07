import { test, expect } from '@playwright/test'
const harness = '/tests/browser/workflow-tools.html'
test.beforeEach(async ({ page }) => { page.on('pageerror', error => console.error('PAGE ERROR', error.message)) })

test('ruler, area, profile and volume measure in the recorded product frame', async ({ page }) => {
  await page.goto(harness)
  await page.evaluate(() => {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 100
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#888'; ctx.fillRect(0,0,100,100)
    window.workflowTools.recon.dem = { width:100,height:100,originX:0,originY:100,gsd:1,unit:'m',crs:'local',data:new Float32Array(10000).fill(42),previewDataUrl:canvas.toDataURL() }
  })
  const tool = (t) => page.getByRole('button', { name:`measure-${t}`, exact:true }).click()
  const result = page.getByRole('region', { name:'Measurement result' })
  const headline = result.locator('.mp-value')
  const viewport = page.locator('.viewport'), box = await viewport.boundingBox()
  const at = (x, y) => viewport.click({ position:{ x:box.width/2+x,y:box.height/2+y } })
  await tool('length')
  await expect(page.getByRole('toolbar', { name:'Ruler measurement' })).toBeVisible()
  await at(-20, 0); await at(20, 0)
  await expect(headline).toHaveText('40.00 m')
  await result.getByRole('textbox', { name:'Measurement name' }).fill('Courtyard')
  await result.getByRole('button', { name:'Save measurement', exact:true }).click()
  await tool('area')
  for (const [x,y] of [[-20,-20],[20,-20],[20,20],[-20,20]]) await at(x, y)
  await expect(headline).toHaveText('1,600.00 m²')
  await expect(result.getByText('160.00 m', { exact:true })).toBeVisible() // perimeter
  await tool('profile')
  for (const x of [-20,20]) await at(x, 0)
  await expect(result.getByText('42.00 – 42.00 m', { exact:true })).toBeVisible()
  const downloadPromise = page.waitForEvent('download')
  await result.getByRole('button', { name:'Export profile CSV' }).click()
  expect((await downloadPromise).suggestedFilename()).toBe('elevation-profile.csv')
  // Volume over the flat 42 m DEM: zero against the vertex plane, 2 m × covered
  // cells against a custom 40 m base, with full coverage reported.
  await tool('volume')
  for (const [x,y] of [[-20,-20],[20,-20],[20,20],[-20,20]]) await at(x, y)
  await expect(headline).toHaveText('0 m³')
  await expect(result.getByText(/^100\.0% of 1,?600 cells$/)).toBeVisible()
  await page.getByRole('combobox', { name:'Volume base surface' }).selectOption('custom')
  await page.getByRole('spinbutton', { name:'Base height' }).fill('40')
  await expect(headline).toHaveText('3,200 m³')
  await result.getByRole('textbox', { name:'Measurement name' }).fill('Stockpile')
  await result.getByRole('button', { name:'Save measurement', exact:true }).click()
  // Esc clears the drawing, a second Esc leaves the tool.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('toolbar', { name:'Volume measurement' })).toBeVisible()
  await at(0, 0)
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape')
  await expect(page.getByRole('toolbar', { name:'Volume measurement' })).toHaveCount(0)
  await page.evaluate(async () => {
    const { projects, measurements } = window.workflowTools
    projects.currentProjectId = 'measurement-browser'; projects.persistenceAvailable = true
    await measurements.save(); measurements.clear(); await measurements.restore({ projectId: projects.currentProjectId })
  })
  await tool('saved')
  const list = page.getByRole('complementary', { name:'Saved measurements' })
  await list.getByRole('button', { name:/Stockpile/ }).click()
  await expect(headline).toHaveText('3,200 m³')
  await list.getByRole('button', { name:/Courtyard/ }).click()
  await expect(headline).toHaveText('40.00 m')
  await page.evaluate(() => { window.workflowTools.recon.dem = { ...window.workflowTools.recon.dem, createdAt: 2 } })
  // A rebuild resets the tool but leaves the saved list open, now flagging staleness.
  await list.getByRole('button', { name:/Courtyard.*stale/ }).click()
  await expect(result.getByText('Source raster or coordinate frame changed.', { exact:false })).toBeVisible()
  await expect(headline).toHaveText('40.00 m')
})

test('raw uint16 GeoTIFF windows survive styling and cached restyles avoid band decoding', async ({ page }) => {
  await page.goto(harness)
  const result = await page.evaluate(async () => {
    const { writeGeoTiff, geoKeysForEpsg } = await import('/src/core/products/geotiff.js')
    const { readRasterWindow, restyleRasterPreview } = await import('/src/workers/computeClient.js')
    const data = new Uint16Array(64*64); for (let i=0;i<data.length;i++) data[i] = 1000+i
    const bytes = writeGeoTiff({ width:64,height:64,samples:[{bits:16,format:1}],photometric:1,data:new Uint8Array(data.buffer),pixelScale:[2,2,0],tiepoint:[0,0,0,100,200,0],geoKeys:geoKeysForEpsg(3031,false) })
    const file = new File([bytes], 'reference.tif')
    const source = await window.workflowTools.external.importRaster(file, { forceKind:'ortho' })
    const a = await readRasterWindow(file, { rect:{ col:2,row:3,width:2,height:2 }, maxDim:100 })
    const first = await restyleRasterPreview(file, 'test', { mode:'gray',gamma:1 }, { cacheKey:'browser-test' })
    const second = await restyleRasterPreview(file, 'test', { mode:'gray',gamma:2 }, { cacheKey:'browser-test' })
    const b = await window.workflowTools.external.readRasterWindow(source.id, { rect:{ col:2,row:3,width:2,height:2 }, maxDim:100 })
    return { before:[...a.channels[0]], after:[...b.channels[0]], changed:first.previewDataUrl !== second.previewDataUrl, crs:source.crs, decoded:[first.decodedBands, second.decodedBands] }
  })
  expect(result).toEqual({ before:[1194,1195,1258,1259],after:[1194,1195,1258,1259],changed:true,crs:'EPSG:3031',decoded:[1,0] })
})

test('sparse gradual selection refines through real WASM and invalidates derived products', async ({ page }) => {
  await page.goto(harness)
  await page.evaluate(() => {
    const R = [[1,0,0],[0,1,0],[0,0,1]], K = { fx:100,fy:100,cx:0,cy:0 }
    const cameras = new Map([['a',{R,t:[0,0,0],K}],['b',{R,t:[-1,0,0],K}]])
    const points = Array.from({length:30},(_,i) => { const x=(i%5)/5,y=Math.floor(i/5)/5,z=10+i%3; return {x,y,z,views:new Map([['a',i],['b',i]]),viewsPx:new Map([['a',[100*x/z,100*y/z+(i===29?30:0)]],['b',[100*(x-1)/z,100*y/z]]])} })
    const recon = window.workflowTools.recon
    recon.clouds = [{id:'s',kind:'sparse',name:'Sparse',createdAt:1,cameras,points}]; recon.mainSparseId = 's'
    recon.dem = {width:1,height:1,data:new Float32Array([1]),unit:'model'}
    recon.summary = {selfCalDistortion:[{sensorId:'sensor',k1:.01}],fiducialTransforms:[]}
  })
  await page.getByRole('button', {name:'Gradual selection',exact:true}).click()
  await expect(page.getByText('1 selected · 29 remaining')).toBeVisible()
  await page.getByRole('button', {name:'Delete selected + refine'}).click()
  await expect(page.locator('#edited')).toHaveText('29')
  expect(await page.evaluate(() => ({ dem:window.workflowTools.recon.dem,cal:window.workflowTools.recon.summary.selfCalDistortion[0].k1 }))).toEqual({dem:null,cal:.01})
})

test('Find GCPs matches real pixels and imports only explicitly reviewed candidates', async ({ page }) => {
  await page.goto(harness)
  await page.evaluate(async () => {
    const { writeGeoTiff,geoKeysForEpsg } = await import('/src/core/products/geotiff.js')
    const { detectKeypoints } = await import('/src/workers/computeClient.js')
    const canvas = document.createElement('canvas'); canvas.width=canvas.height=700
    const ctx = canvas.getContext('2d'); ctx.fillStyle='#888'; ctx.fillRect(0,0,700,700)
    let seed=1234; const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296}
    for(let i=0;i<1500;i++){const g=Math.floor(random()*256);ctx.fillStyle=`rgb(${g},${g},${g})`;ctx.beginPath();ctx.arc(random()*700,random()*700,2+random()*9,0,Math.PI*2);ctx.fill()}
    const rgba=ctx.getImageData(0,0,700,700).data, data=new Uint8Array(700*700)
    for(let i=0;i<data.length;i++)data[i]=rgba[i*4]
    const url=canvas.toDataURL(), detected=await detectKeypoints(url,{maxDim:700,maxKeypoints:4000})
    const {recon,external,images,projects}=window.workflowTools
    projects.projects=[{id:'gcp-test',crs:'EPSG:3031'}];projects.currentProjectId='gcp-test'
    images.images=[{id:'a',uuid:'a',name:'a.jpg'},{id:'b',uuid:'b',name:'b.jpg'}]
    const R=[[1,0,0],[0,1,0],[0,0,1]],K={fx:100,fy:100,cx:0,cy:0}
    const cameras=new Map([['a',{R,t:[0,0,0],K}],['b',{R,t:[-1,0,0],K}]])
    const points=detected.keypoints.map((p,i)=>({x:p.x+0.5,y:700-p.y-0.5,z:10,views:new Map([['a',i],['b',i]]),viewsPx:new Map([['a',[p.x,p.y]],['b',[p.x+1,p.y]]])}))
    recon.clouds=[{id:'s',kind:'sparse',name:'Sparse',createdAt:1,cameras,points}];recon.mainSparseId='s'
    recon.ortho={width:700,height:700,originX:0,originY:700,gsd:1,previewDataUrl:url,frame:{kind:'local',origin:[0,0,0],east:[1,0,0],north:[0,1,0],up:[0,0,1]}}
    const bytes=writeGeoTiff({width:700,height:700,samples:[{bits:8,format:1}],photometric:1,data,pixelScale:[2,2,0],tiepoint:[0,0,0,1000,2000,0],geoKeys:geoKeysForEpsg(3031,false)})
    const imported = await external.importRaster(new File([bytes],'reference.tif'),{forceKind:'ortho'})
    if (!imported) { const { useLog } = await import('/src/composables/useLog.js'); throw new Error(JSON.stringify(useLog().entries.value)) }
    const demBytes=writeGeoTiff({width:700,height:700,samples:[{bits:32,format:3}],photometric:1,data:new Uint8Array(new Float32Array(700*700).fill(42).buffer),pixelScale:[2,2,0],tiepoint:[0,0,0,1000,2000,0],geoKeys:geoKeysForEpsg(3031,false)})
    const dem=await external.importRaster(new File([demBytes],'height.tif'),{forceKind:'dem'})
    await external.setVerticalInfo(dem.id,{verticalDatum:'orthometric',verticalAccuracy:1.5})
  })
  await page.getByRole('button',{name:'Find GCPs',exact:true}).click()
  await page.getByRole('button',{name:'Find candidates',exact:true}).click()
  const accept=page.getByRole('checkbox')
  await expect(accept.first()).toBeVisible({timeout:20000})
  expect(await page.evaluate(()=>window.workflowTools.gcps.gcps.length)).toBe(0)
  await accept.first().check()
  await expect(page.getByLabel('Candidate close-up')).toHaveCount(2)
  await page.getByRole('combobox', { name:'Role', exact:true }).selectOption('check')
  await page.getByLabel('σ X (project units, 1σ)').fill('2')
  await page.getByLabel('σ Y (project units, 1σ)').fill('3')
  await page.getByRole('combobox', { name:'Reference DEM', exact:true }).selectOption({ label:'height.tif' })
  await page.getByRole('button', { name:'Fill selected heights' }).click()
  await expect(page.getByLabel('Elevation', { exact:true })).toHaveValue('42')
  await page.getByRole('button',{name:'Add 1 reviewed candidates'}).click()
  expect(await page.evaluate(()=>window.workflowTools.gcps.gcps.map(g=>({z:g.z,accuracy:g.accuracyX,accuracyZ:g.accuracyZ,role:g.role,observations:g.observations.length})))).toEqual([{z:42,accuracy:2,accuracyZ:1.5,role:'check',observations:2}])
})

test('bounded SIFT batch preserves serial results and records throughput', async ({ page }) => {
  test.setTimeout(60000)
  await page.goto(harness)
  const measured = await page.evaluate(async () => {
    const compute = await import('/src/workers/computeClient.js')
    compute.configureWorkerPoolSize(4)
    const store = window.workflowTools.images
    let seed = 12345; const random = () => { seed = (1664525*seed+1013904223)>>>0; return seed/4294967296 }
    for(let n=0;n<8;n++) {
      const canvas=document.createElement('canvas'); canvas.width=canvas.height=1200
      const ctx=canvas.getContext('2d');ctx.fillStyle='#888';ctx.fillRect(0,0,1200,1200)
      for(let i=0;i<3500;i++){const g=Math.floor(random()*256);ctx.fillStyle=`rgb(${g},${g},${g})`;ctx.beginPath();ctx.arc(random()*1200,random()*1200,2+random()*12,0,Math.PI*2);ctx.fill()}
      store.images.push({id:`i${n}`,uuid:`u${n}`,name:`synthetic-${n}.png`,url:canvas.toDataURL(),meta:{width:1200,height:1200},kpStatus:null})
    }
    const settings={maxDim:1200,maxKeypoints:5000,contrastThreshold:.01,overwrite:true}
    for(let i=0;i<4;i++)await compute.detectKeypoints(store.images[i].url,settings)
    let start=performance.now()
    for(const im of store.images)await store.detectOne(im.id,settings)
    const serialMs=performance.now()-start
    const expected=store.images.map(im=>({points:JSON.stringify(im.keypoints),descriptors:im.descriptors.slice()}))
    start=performance.now();await store.detectAll(settings);const batchMs=performance.now()-start
    const identical=store.images.every((im,i)=>JSON.stringify(im.keypoints)===expected[i].points && im.descriptors.every((v,j)=>v===expected[i].descriptors[j]))
    return {serialMs:Math.round(serialMs),batchMs:Math.round(batchMs),identical,pool:compute.POOL_SIZE}
  })
  console.log('SIFT throughput:', JSON.stringify(measured))
  expect(measured.identical).toBe(true)
})


test('COG display renders in EPSG:3031 and GPU style changes preserve raw values', async ({ page }) => {
  await page.goto(harness)
  const result = await page.evaluate(async () => {
    const { writeGeoTiff, geoKeysForEpsg } = await import('/src/core/products/geotiff.js')
    const { fromBlob } = await import('/node_modules/geotiff/dist-module/geotiff.js')
    const data = new Uint16Array(1024 * 1024 * 6)
    for (let i = 0; i < data.length; i++) data[i] = 1000 + (i % 2000)
    const bytes = writeGeoTiff({ width:1024, height:1024, samples:Array.from({length:6},()=>({bits:16,format:1})), photometric:2,
      data:new Uint8Array(data.buffer), pixelScale:[2,2,0], tiepoint:[0,0,0,1000,2000,0], geoKeys:geoKeysForEpsg(3031,false) })
    const { external, showRaster } = window.workflowTools
    const start = performance.now(), r = await external.importRaster(new File([bytes], 'polar.tif'), { forceKind:'ortho' })
    const previewMs = performance.now() - start
    const hasFullPlane = !!external.sources.get(r.id)?.rgba()?.length
    const file = await external.displayFile(r.id), tiff = await fromBlob(file), first = await tiff.getImage()
    if (!first.isTiled) { const { useLog } = await import('/src/composables/useLog.js'); throw new Error(JSON.stringify(useLog().entries.value)) }
    showRaster(r.id)
    const raw = await external.readRasterWindow(r.id, { rect:{col:10,row:10,width:1,height:1}, bands:[0] })
    const cogRaw = await first.readRasters({ window:[10,10,11,11], samples:[0], interleave:true })
    if (cogRaw[0] !== raw.data[0]) throw new Error('COG changed a full-resolution sample')
    return { id:r.id, tiled:first.isTiled, levels:await tiff.getImageCount(), hasFullPlane, raw:raw.data[0], previewMs }
  })
  expect(result.tiled).toBe(true); expect(result.levels).toBeGreaterThan(1); expect(result.hasFullPlane).toBe(false)
  await expect(page.locator('.raster')).toBeHidden({ timeout:20000 })
  const canvas = page.locator('.gpu-raster-canvas')
  const before = await canvas.screenshot()
  await page.evaluate(async id => {
    await window.workflowTools.external.setRasterStyle(id, { mode:'rgb',bandR:3,bandG:4,bandB:5,stretch:'manual',manual:[[0,6000],[0,6000],[0,6000]],gamma:2 })
  }, result.id)
  await page.waitForTimeout(200)
  const after = await canvas.screenshot()
  expect(before.equals(after)).toBe(false)
  await page.evaluate(async id => { await window.workflowTools.external.setRasterStyle(id, { mode:'index',bandA:4,bandB2:2,ramp:'rdylgn',gamma:1 }) }, result.id)
  await page.waitForTimeout(200)
  expect(after.equals(await canvas.screenshot())).toBe(false)
  await page.evaluate(async id => { await window.workflowTools.external.setRasterStyle(id, { mode:'gray',band:5,stretch:'manual',manual:[[0,6000]],gamma:1 }) }, result.id)
  await page.waitForTimeout(200)
  expect(after.equals(await canvas.screenshot())).toBe(false)
  await page.locator('.viewport').hover(); await page.mouse.wheel(0,-400)
  const raw = await page.evaluate(async id => (await window.workflowTools.external.readRasterWindow(id, { rect:{col:10,row:10,width:1,height:1},bands:[0] })).data[0], result.id)
  expect(raw).toBe(result.raw)
  console.log('Raster first preview:', Math.round(result.previewMs), 'ms; COG levels:', result.levels)
})


test('matching records worker stages separately from descriptor serialization', async ({ page }) => {
  await page.goto(harness)
  const timings = await page.evaluate(async () => {
    const { useMatchesStore } = await import('/src/stores/useMatchesStore.js')
    let seed=17; const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296}
    const n=800, descriptors=Float32Array.from({length:n*128},random)
    const points=Array.from({length:n},()=>({x:random()*4-2,y:random()*3-1.5,z:5+random()*6}))
    const images=Array.from({length:3},(_,j)=>({id:`m${j}`,uuid:`m${j}`,name:`match-${j}`,kpStatus:'done',descDim:128,detector:'sift',descriptors:descriptors.slice(),meta:{width:1000,height:1000},
      keypoints:points.map(p=>({x:500+500*(p.x-j*.4)/p.z,y:500+500*p.y/p.z,scale:1}))}))
    const store=useMatchesStore()
    await store.matchAll(images,{strategy:'exhaustive',subsetGate:false,minMatches:8,maxIters:200,overwrite:true})
    return store.matchRun.timings
  })
  expect(timings.wallMs).toBeGreaterThan(0)
  expect(timings.matchingMs).toBeGreaterThan(0)
  expect(timings.verificationMs).toBeGreaterThan(0)
  expect(timings.postMessageMs).toBeGreaterThanOrEqual(0)
  console.log('Matching stage timings:', JSON.stringify(timings))
})

test('saved depth maps fuse through file handles without hydrating the full set', async ({ page }) => {
  await page.goto(harness)
  const result = await page.evaluate(async () => {
    const opfs = await import('/src/utils/opfs.js')
    const { buildDepthIndex, serializeDepthMap } = await import('/src/core/dense/depthMapCodec.js')
    const { recon, projects } = window.workflowTools
    projects.currentProjectId = 'streamed-depth-browser'; projects.persistenceAvailable = true
    const R=[[1,0,0],[0,-1,0],[0,0,-1]], K={fx:30,fy:30,cx:16,cy:16}
    const maps=Array.from({length:3},(_,j)=>({uuid:`depth-${j}`,width:32,height:32,K,R,t:[-j/4,0,10],
      depth:new Float32Array(1024).fill(10),cost:new Float32Array(1024).fill(.1),rgb:new Uint8Array(3072).fill(120)}))
    const sparse={id:'s',kind:'sparse',createdAt:1,points:[],cameras:new Map(maps.map(m=>[m.uuid,{K,R,t:m.t}]))}
    recon.clouds=[sparse]; recon.mainSparseId='s'
    const index=buildDepthIndex(maps,{sparseCloud:sparse})
    await opfs.saveDepthPlanes(projects.currentProjectId,index,maps.map(m=>({uuid:m.uuid,buffers:serializeDepthMap(m).buffers})))
    recon.depthMapsMeta=index.maps
    await recon.densify({minViews:1,minTriAngleDeg:0,removeIsolated:false})
    if (recon.reconStatus === 'error') { const { useLog }=await import('/src/composables/useLog.js'); throw new Error(JSON.stringify(useLog().entries.value)) }
    return { count:recon.clouds.find(c=>c.kind==='dense')?.count, resident:recon.depthMaps.size, saved:recon.depthMapsMeta.length }
  })
  expect(result.count).toBeGreaterThan(0); expect(result.resident).toBe(0); expect(result.saved).toBe(3)
})
