import { test, expect } from '@playwright/test'
const harness = '/tests/browser/harness.html'

test('nested modal Cancel stays safe on Enter, traps focus and restores it', async ({ page }) => {
  await page.goto(harness)
  await page.locator('#launch').click()
  await expect(page.getByLabel('Visible field')).toBeFocused()
  expect(await page.locator('#launch').evaluate(el => el.inert)).toBe(true)
  await page.locator('#delete').click()
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('#confirmed')).toHaveText('false')
  await expect(page.locator('#delete')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close outer' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Close', exact: true })).toBeFocused()
  await page.getByRole('button', { name: 'Close outer' }).click()
  await expect(page.locator('#launch')).toBeFocused()
  expect(await page.locator('#launch').evaluate(el => el.inert)).toBe(false)
})

test('real OPFS product save, replacement, reopen and deletion', async ({ page }) => {
  await page.goto(harness)
  await page.evaluate(async () => {
    const opfs = await import('/src/utils/opfs.js')
    await opfs.saveProduct('browser-test', 'dem', { width: 1, height: 1, data: new Float32Array([12.5]), mask: new Uint8Array([1]) })
  })
  await page.reload()
  expect(await page.evaluate(async () => {
    const opfs = await import('/src/utils/opfs.js')
    const old = await opfs.loadProduct('browser-test', 'dem')
    await opfs.saveProduct('browser-test', 'dem', { width: 2, height: 1, data: new Float32Array([22, 23]), mask: new Uint8Array([1, 1]) })
    const next = await opfs.loadProduct('browser-test', 'dem')
    await opfs.deleteProduct('browser-test', 'dem')
    return { old: old.data[0], next: [...next.data], deleted: await opfs.loadProduct('browser-test', 'dem') }
  })).toEqual({ old: 12.5, next: [22, 23], deleted: null })
})

test('two tabs preserve independent projects and refuse simultaneous editing', async ({ page, context }) => {
  const other = await context.newPage()
  await Promise.all([page.goto(harness), other.goto(harness)])
  const init = async () => {
    const { createPinia } = await import('/node_modules/.vite/deps/pinia.js')
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    window.projects = useProjectsStore(createPinia())
    await window.projects.loadIndex()
  }
  await page.evaluate(init); await other.evaluate(init)
  const [a, b] = await Promise.all([
    page.evaluate(() => window.projects.createProject('A', 'object')),
    other.evaluate(() => window.projects.createProject('B', 'object')),
  ])
  const ids = await page.evaluate(async () => (await (await import('/src/utils/opfs.js')).readIndex()).projects.map(p => p.id))
  expect(ids.sort()).toEqual([a, b].sort())
  expect(await other.evaluate(async id => {
    await window.projects.loadIndex()
    try { await window.projects.switchProject(id); return 'opened' } catch (error) { return error.message }
  }, a)).toContain('already open in another tab')
  await page.close()
  await other.evaluate(id => window.projects.switchProject(id), a)
})

test('LAS import/export retains survey precision and ZIP extraction runs in a worker', async ({ page }) => {
  await page.goto(harness)
  const result = await page.evaluate(async () => {
    const { cloudToLas, parseLas } = await import('/src/core/io/las.js')
    const { readSfmZip } = await import('/src/workers/archive/zipClient.js')
    const { zipStore } = await import('/src/utils/zip.js')
    const bytes = cloudToLas([{ x: 7e6 + .01, y: 5e5, z: 1 }, { x: 7e6 + .02, y: 5e5, z: 2 }])
    const cloud = parseLas(bytes)
    const archive = zipStore([{ name: 'cameras.txt', data: new TextEncoder().encode('camera-model') }])
    const extracted = await readSfmZip(new File([archive], 'model.zip'))
    const controller = new AbortController()
    controller.abort()
    let cancelled = false
    try { await readSfmZip(new File([archive], 'model.zip'), { signal: controller.signal }) }
    catch (error) { cancelled = error.name === 'AbortError' }
    return { delta: cloud.pos[3] - cloud.pos[0], model: new TextDecoder().decode(extracted.entries[0].data), cancelled }
  })
  expect(result.delta).toBeCloseTo(.01, 6)
  expect(result.model).toBe('camera-model')
  expect(result.cancelled).toBe(true)
})

test('failed writes on real OPFS retain the committed DEM', async ({ page }) => {
  await page.goto(harness)
  const result = await page.evaluate(async () => {
    const opfs = await import('/src/utils/opfs.js')
    const { retryPersistence } = await import('/src/utils/persistence.js')
    const dir = await opfs.getOpfsProjectDir('fault-test', true)
    let fail = false
    const wrap = handle => ({ name: handle.name,
      keys: () => handle.keys(),
      removeEntry: (...args) => handle.removeEntry(...args),
      getDirectoryHandle: async (...args) => wrap(await handle.getDirectoryHandle(...args)),
      getFileHandle: async (name, ...args) => {
        const fh = await handle.getFileHandle(name, ...args)
        return { getFile: () => fh.getFile(), createWritable: async (...options) => {
          const writable = await fh.createWritable(...options)
          return { write: value => { if (fail && name.endsWith('.data.bin')) throw new Error('Injected disk failure'); return writable.write(value) },
            close: () => writable.close(), abort: () => writable.abort() }
        } }
      },
    })
    opfs.setProjectRoot('fault-test', wrap(dir))
    const product = n => ({ width: n, height: 1, data: new Float32Array(n).fill(n), mask: new Uint8Array(n).fill(1) })
    await opfs.saveProduct('fault-test', 'dem', product(1))
    fail = true
    let rejected = false
    try { await opfs.saveProduct('fault-test', 'dem', product(2)) } catch { rejected = true }
    const saved = await opfs.loadProduct('fault-test', 'dem')
    fail = false
    await retryPersistence()
    return { rejected, width: saved.width, pixels: [...saved.data], retried: (await opfs.loadProduct('fault-test', 'dem')).width }
  })
  expect(result).toEqual({ rejected: true, width: 1, pixels: [1], retried: 2 })
})

test('project archive round-trip includes committed cloud and raster generations', async ({ page }) => {
  await page.goto(harness)
  expect(await page.evaluate(async () => {
    const opfs = await import('/src/utils/opfs.js')
    const { exportProjectArchive, importProjectArchive } = await import('/src/utils/projectFile.js')
    const { buildManifest } = await import('/src/core/io/projectArchive.js')
    const project = { id: 'archive-source', name: 'Archive test', sceneType: 'object', crs: 'EPSG:3031' }
    await opfs.writeProject(project.id, { ...project, images: [] })
    await opfs.saveReconstruction(project.id, { clouds: [{ id: 'cloud', kind: 'dense', pointCount: 1,
      buffers: { pos: new Float64Array([7e6 + .01, 5e5 + .01, 1]).buffer } }] })
    await opfs.saveProduct(project.id, 'dem', { width: 1, height: 1, data: new Float32Array([1]), mask: new Uint8Array([1]) })
    const chunks = []
    await exportProjectArchive({ projectId: project.id, manifest: buildManifest({ project }), fileName: 'test.websfm',
      openSink: async () => ({ streaming: true, write: data => chunks.push(data.slice()), close() {}, abort() {} }) })
    await importProjectArchive({ projectId: 'archive-target', file: new File(chunks, 'test.websfm') })
    const model = await opfs.loadReconstruction('archive-target')
    const dem = await opfs.loadProduct('archive-target', 'dem')
    return { x: new Float64Array(model.clouds[0].buffers.pos)[0], height: dem.data[0] }
  })).toEqual({ x: 7e6 + .01, height: 1 })
})

test('the full application creates and reopens a project without runtime errors', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByPlaceholder('My Project').fill('Browser smoke project')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'New Project', exact: true })).toHaveCount(0)
  const projectButton = page.getByRole('button', { name: 'Browser smoke project ▾', exact: true })
  await expect(projectButton).toBeVisible()
  await projectButton.click()
  await expect(page.locator('.project-picker')).toBeVisible()
  await projectButton.click()
  await expect(page.locator('.project-picker')).toHaveCount(0)
  await page.evaluate(async () => (await import('/src/utils/persistence.js')).flushPersistence())
  await page.reload()
  // The project picker is expected on startup; the created project must survive.
  await expect(page.getByText('Browser smoke project', { exact: true }).first()).toBeVisible()
  expect(errors).toEqual([])
})

test('ORT loads runtime assets from its installed version path', async ({ page }) => {
  await page.goto(harness)
  const result = await page.evaluate(async () => {
    const { getOrt } = await import('/src/core/features/ort.js')
    const ort = await getOrt()
    const url = `${ort.env.wasm.wasmPaths}ort-wasm-simd-threaded.mjs`
    const response = await fetch(url)
    return { path: ort.env.wasm.wasmPaths, version: ort.env.versions.web, ok: response.ok, bytes: (await response.text()).length }
  })
  expect(result.path).toBe(`/ort/${result.version}/`)
  expect(result.ok).toBe(true)
  expect(result.bytes).toBeGreaterThan(1000)
})
