import { test, expect } from '@playwright/test'

test('cloud layers, symbology, legend and point attributes survive project reload', async ({ page }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'My Project ▾', exact: true })).toBeVisible()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    for (let tile = 0; tile < 2; tile++) {
      store.importCloud({ count: 3,
        pos: new Float64Array([500000 + tile * 10, 7000000, 0, 500001 + tile * 10, 7000000, 1, 500002 + tile * 10, 7000000, 2]),
        col: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]),
        attributes: { classification: new Uint8Array([2, 6, 2]), intensity: new Uint16Array([100, 200, 300]) },
      }, `tile-${tile}.laz`)
    }
    await (await import('/src/utils/persistence.js')).flushPersistence()
  })
  // Inspect the actual scene in the development build, without adding a test-only
  // public API to the production viewer. Both layers must have GPU draw objects.
  const sceneLayers = () => page.locator('.viewer').evaluate(el => {
    const layers = el.__vueParentComponent.setupState.cloudLayers
    return [...layers.values()].map(layer => ({ id: layer.source.id, x: layer.object.position.x,
      count: layer.object.geometry.getAttribute('position').count,
      drawn: layer.object.geometry.index?.count ?? layer.count }))
  })
  await expect.poll(async () => (await sceneLayers()).length).toBe(2)
  const layers = await sceneLayers()
  expect(Math.abs(layers[1].x - layers[0].x)).toBe(10)
  await page.getByRole('button', { name: /Reference Data/ }).click()
  const first = page.locator('.list-item').filter({ hasText: 'Imported (tile-0.laz)' })
  await first.click()
  await expect.poll(async () => (await sceneLayers()).length).toBe(2)
  await first.click({ button: 'right' })
  await page.getByRole('button', { name: 'Symbology…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Point cloud symbology' })
  await dialog.getByLabel('Colour by', { exact: true }).selectOption('attribute:classification')
  await expect(dialog.getByText('6 · Building', { exact: true })).toBeVisible()
  await page.screenshot({ path: test.info().outputPath('symbology.png') })
  await dialog.getByLabel('Show Building', { exact: true }).uncheck()
  await dialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect.poll(async () => (await sceneLayers())[0].drawn).toBe(2)
  await page.getByRole('button', { name: 'Legend', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Legend', exact: true })).toHaveClass(/active/)
  const legend = page.getByRole('complementary', { name: 'Point cloud legend' })
  await expect(legend.getByText('2 · Ground', { exact: true })).toBeVisible()
  await expect(legend.getByText('Imported (tile-1.laz)', { exact: true })).toHaveCount(0)
  await expect(legend.getByText('6 · Building', { exact: true })).toHaveCount(0)
  await page.screenshot({ path: test.info().outputPath('legend.png') })
  await page.getByLabel('Show Imported (tile-1.laz) in 3D', { exact: true }).uncheck()
  await expect.poll(async () => (await sceneLayers()).length).toBe(1)
  await expect(legend.getByText('Imported (tile-1.laz)', { exact: true })).toHaveCount(0)
  // Point size is a ribbon stepper now (View ▸ Scene), not an in-view popover.
  await page.getByRole('button', { name: 'Larger points', exact: true }).click()
  await expect.poll(() => page.locator('.viewer').evaluate(el => [...el.__vueParentComponent.setupState.cloudLayers.values()][0].object.material.size)).toBe(4)
  await page.evaluate(async () => (await import('/src/utils/persistence.js')).flushPersistence())
  await page.reload()
  await page.locator('.project-main').filter({ hasText: 'My Project' }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect.poll(async () => (await sceneLayers()).length).toBe(1)
  const restored = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().clouds.map(c => ({ visible: c.visible, field: c.style?.field,
      intensity: [...c.attributes.intensity], classes: [...c.attributes.classification] }))
  })
  expect(restored).toEqual([
    { visible: true, field: 'attribute:classification', intensity: [100, 200, 300], classes: [2, 6, 2] },
    { visible: false, field: undefined, intensity: [100, 200, 300], classes: [2, 6, 2] },
  ])
  const closeNear = await page.locator('.viewer').evaluate(el => {
    const state = el.__vueParentComponent.setupState
    state.camera.position.copy(state.controls.target).addScalar(0.001)
    state.updateClipping()
    return state.camera.near
  })
  expect(closeNear).toBeGreaterThan(0)
  expect(closeNear).toBeLessThan(0.00001)
  await page.getByRole('button', { name: 'Other', exact: true }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
  await settings.getByRole('tab', { name: 'Map & 3D', exact: true }).click()
  const clipping = settings.getByLabel('3D near clipping distance', { exact: true })
  await clipping.fill('0.002')
  await clipping.press('Tab')
  await expect.poll(() => page.locator('.viewer').evaluate(el => el.__vueParentComponent.setupState.camera.near)).toBe(0.002)
  expect(await page.evaluate(() => localStorage.getItem('viewer3dNearClip'))).toBe('0.002')
  expect(errors).toEqual([])
})

test('elevation clouds share one translucent legend and equal heights have equal colours', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'My Project ▾', exact: true })).toBeVisible()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    for (let i = 0; i < 2; i++) store.importCloud({ count: 2,
      pos: new Float64Array([500000 + i * 10, 7000000, i * 10, 500001 + i * 10, 7000000, i * 10 + 10]),
      col: new Uint8Array([255, 0, 0, 0, 255, 0]),
    }, `height-${i}.laz`)
  })
  await page.getByRole('button', { name: 'Legend', exact: true }).click()
  const legend = page.getByRole('complementary', { name: 'Point cloud legend' })
  await expect(legend).toHaveCount(0) // RGB needs no legend.
  await page.getByRole('button', { name: /Reference Data/ }).click()
  for (let i = 0; i < 2; i++) {
    await page.locator('.list-item').filter({ hasText: `Imported (height-${i}.laz)` }).click({ button: 'right' })
    await page.getByRole('button', { name: 'Symbology…', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Point cloud symbology' })
    await dialog.getByLabel('Colour by', { exact: true }).selectOption('elevation')
    await expect(dialog.getByLabel('Range', { exact: true })).toHaveValue('auto')
    await dialog.getByRole('button', { name: 'OK', exact: true }).click()
  }
  await expect(legend.locator('.ramp')).toHaveCount(1)
  await expect(legend.getByText('2 clouds', { exact: true })).toBeVisible()
  const colors = await page.locator('.viewer').evaluate(el => [...el.__vueParentComponent.setupState.cloudLayers.values()]
    .map(layer => [...layer.object.geometry.getAttribute('color').array]))
  expect(colors[0].slice(3, 6)).toEqual(colors[1].slice(0, 3))
  await expect(legend.locator('.legend-range')).toHaveText('020')
  const viewerBox = await page.locator('.viewer').boundingBox()
  const legendBox = await legend.boundingBox()
  expect(legendBox.x).toBeGreaterThan(viewerBox.x + viewerBox.width / 2)
  expect(legendBox.y - viewerBox.y).toBeLessThan(20)
  expect(await legend.evaluate(el => getComputedStyle(el).backgroundColor)).toMatch(/0\.85/)
  await page.screenshot({ path: test.info().outputPath('shared-elevation-legend.png') })
  await page.getByLabel('Show Imported (height-1.laz) in 3D', { exact: true }).uncheck()
  await expect(legend.locator('.legend-range')).toHaveText('020')
  expect(await page.locator('.viewer').evaluate(el => [...el.__vueParentComponent.setupState.cloudLayers.values()][0].object.geometry.getAttribute('color').array[3]))
    .toBe(colors[0][3])
  await page.locator('.list-item').filter({ hasText: 'Imported (height-0.laz)' }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Symbology…', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Point cloud symbology' })
  await dialog.getByLabel('Range', { exact: true }).selectOption('local')
  await dialog.getByLabel('Colour by', { exact: true }).selectOption('x')
  await expect(dialog.getByLabel('Range', { exact: true })).toHaveValue('auto')
})

test('a single cloud keeps the nearer point visible while the camera moves at survey scale', async ({ page }) => {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.getByRole('button', { name: 'My Project ▾', exact: true })).toBeVisible()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const pixels = await page.locator('.viewer').evaluate(async el => {
    const THREE = await import('/node_modules/.vite/deps/three.js')
    const state = el.__vueParentComponent.setupState
    state.setCloudLayers([{ id: 'depth', name: 'Depth test', kind: 'dense', count: 2, cameras: new Map(),
      pos: new Float64Array([500000, 7000000, 0, 500000, 7000000, -0.01]),
      col: new Uint8Array([255, 0, 0, 0, 0, 255]),
    }])
    state.grid.visible = false
    const target = new THREE.WebGLRenderTarget(64, 64)
    const previousTarget = state.renderer.getRenderTarget()
    const result = []
    try {
      state.renderer.setRenderTarget(target)
      state.camera.near = 0.000001
      state.camera.far = 1000000
      state.camera.aspect = 1
      state.camera.up.set(0, 1, 0)
      state.camera.updateProjectionMatrix()
      for (let i = 0; i < 20; i++) {
        state.camera.position.set(500000 + i * 0.1, 7000000, 1000)
        state.camera.lookAt(500000, 7000000, 0)
        state.renderer.render(state.scene, state.camera)
        const pixel = new Uint8Array(4)
        state.renderer.readRenderTargetPixels(target, 32, 32, 1, 1, pixel)
        result.push([...pixel.slice(0, 3)])
      }
    } finally {
      state.renderer.setRenderTarget(previousTarget)
      target.dispose()
    }
    return result
  })
  // Two points within one cloud, separated by only a centimetre in depth. The
  // front red point must consistently occlude the blue point behind it.
  expect(pixels).toEqual(Array.from({ length: 20 }, () => [255, 0, 0]))
  expect(errors).toEqual([])
})
