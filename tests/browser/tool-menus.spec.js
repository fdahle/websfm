import { test, expect } from '@playwright/test'

// Tools tab dropdowns (Point Cloud ▾ / Mesh ▾ / Measure ▾) → tool dialogs → the
// store's non-destructive edit path → the real worker ops, against the full
// application.
// Synthetic inputs: a 30×30 wavy grid as a dense cloud and as a mesh of the same
// surface, imported (no pipeline run needed).

async function seed(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const store = useReconstructionStore()
    const N = 30
    const pos = new Float64Array(N * N * 3),
      col = new Uint8Array(N * N * 3).fill(180)
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = (j * N + i) * 3
        pos[k] = i
        pos[k + 1] = j
        pos[k + 2] = Math.sin(i / 4) * Math.cos(j / 5)
      }
    const idx = []
    for (let j = 0; j < N - 1; j++)
      for (let i = 0; i < N - 1; i++) {
        const a = j * N + i
        idx.push(a, a + 1, a + N, a + 1, a + N + 1, a + N)
      }
    store.importCloud({ count: N * N, pos: pos.slice(), col: col.slice() }, 'grid.ply')
    store.importCloud({ nVerts: N * N, count: idx.length / 3, pos, idx: Uint32Array.from(idx), col }, 'surface.ply')
  })
}

const clouds = (page) =>
  page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().clouds.map((c) => ({
      name: c.name,
      kind: c.kind,
      count: c.count,
      derived: !!c.derived,
      nrm: !!c.nrm,
      attributes: Object.keys(c.attributes || {}),
      style: c.style?.field ?? null,
    }))
  })

async function openTool(page, menu, row) {
  await page.getByRole('button', { name: 'Tools', exact: true }).click()
  await page.locator('.ribbon').getByRole('button', { name: menu }).click()
  await page.getByRole('menuitem', { name: row }).click()
}

test('Point Cloud ▾ and Mesh ▾ tools add derived results through the worker', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await seed(page)

  // Estimate normals: a new cloud with normals, the source untouched.
  await openTool(page, /Point\s*Cloud/, /Estimate normals/)
  await page.getByRole('button', { name: 'Estimate', exact: true }).click()
  await expect.poll(async () => (await clouds(page)).some((c) => c.name.endsWith('(normals)') && c.nrm)).toBe(true)

  // Distance to the mesh: the copy carries a distance attribute and opens coloured by it.
  await openTool(page, 'Measure', /Distance to reference/)
  const dist = page.getByRole('dialog', { name: 'Distance to Reference' })
  // The only mesh is the main one, and its option says so (useSourcePick statusTags).
  await dist.getByLabel('To', { exact: true }).selectOption({ label: 'Imported (surface.ply) (mesh) · main' })
  await dist.getByRole('button', { name: 'Compute', exact: true }).click()
  await expect
    .poll(async () => (await clouds(page)).find((c) => c.name.endsWith('(distance)'))?.style)
    .toBe('attribute:distance')

  // Clean, decimate and smooth the mesh: three derived meshes, the import untouched.
  await openTool(page, 'Mesh', /Clean mesh/)
  await page.getByRole('button', { name: 'Clean', exact: true }).click()
  await expect.poll(async () => (await clouds(page)).filter((c) => c.kind === 'mesh' && c.derived).length).toBe(1)
  await openTool(page, 'Mesh', /Decimate/)
  await page.getByRole('button', { name: 'Decimate', exact: true }).click()
  await expect
    .poll(async () => (await clouds(page)).find((c) => c.name.endsWith('(decimated)'))?.count ?? 0)
    .toBeGreaterThan(0)
  const list = await clouds(page)
  const source = list.find((c) => c.name === 'Imported (surface.ply)')
  const decimated = list.find((c) => c.name.endsWith('(decimated)'))
  expect(decimated.count).toBeLessThan(source.count)
  expect(source.count).toBe(29 * 29 * 2)

  // Area & volume reads the selected mesh synchronously.
  await openTool(page, 'Measure', /Mesh area & volume/)
  const measure = page.getByRole('dialog', { name: 'Mesh Area & Volume' })
  await expect(measure.getByText('Surface area')).toBeVisible()
  // An open terrain surface: no volume, and the dialog says why.
  await expect(measure.getByText('not closed', { exact: true })).toBeVisible()
  await expect(measure.getByText(/open edges \(holes\)/)).toBeVisible()
  await measure.getByRole('button', { name: 'Close', exact: true }).last().click()

  expect(errors).toEqual([])
})

test('Classify points labels a cloud and Build DEM ▸ Ground only makes a DTM under the roof', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // 40×40 m of sloping ground at 0.5 m spacing with a 12 m square roof 6 m up: an
  // imported cloud, so its own z is up and no project scale is needed.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const xyz = []
    for (let x = 0; x <= 40; x += 0.5)
      for (let y = 0; y <= 40; y += 0.5) {
        const roof = x >= 14 && x <= 26 && y >= 14 && y <= 26
        xyz.push(x, y, 0.05 * x + (roof ? 6 : 0))
      }
    const n = xyz.length / 3
    useReconstructionStore().importCloud(
      { count: n, pos: Float64Array.from(xyz), col: new Uint8Array(n * 3).fill(150) },
      'site.ply',
    )
  })

  await openTool(page, /Point\s*Cloud/, /Classify points/)
  await page
    .getByRole('dialog', { name: 'Classify Points' })
    .getByRole('button', { name: 'Classify', exact: true })
    .click()
  await expect
    .poll(async () => (await clouds(page)).find((c) => c.name.endsWith('(classified)'))?.style)
    .toBe('attribute:classification')
  const counts = await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const c = useReconstructionStore().clouds.find((x) => x.name.endsWith('(classified)'))
    const n = [0, 0, 0, 0, 0, 0, 0, 0]
    for (const v of c.attributes.classification) n[v]++
    const hag = c.attributes.heightAboveGround
    const roof = [...hag].filter((_, i) => c.attributes.classification[i] === 6).sort((a, b) => a - b)
    return { ground: n[2], above: n[1], building: n[6], hagCount: hag?.length ?? 0, roofHeight: roof[roof.length >> 1] }
  })
  // Every point carries its height above the ground: the roof stands 6 m up.
  expect(counts.hagCount).toBe(81 * 81)
  expect(counts.roofHeight).toBeCloseTo(6, 0)
  // The 25×25 roof points (12 m at 0.5 m) are a building; everything else is ground.
  expect(counts.building).toBe(25 * 25)
  expect(counts.above).toBe(0)
  expect(counts.ground).toBe(81 * 81 - 25 * 25)

  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().demOpen = true
  })
  const dialog = page.getByRole('dialog', { name: 'Build DEM' })
  await dialog.getByLabel('Points').selectOption('ground')
  // Fill holes, on for a DTM; the Output step's Replace the main DEM follows it.
  await expect(dialog.getByRole('checkbox').first()).toBeChecked()
  await dialog.getByRole('button', { name: 'Build DTM', exact: true }).click()
  // Every cell inside the grid has a height: the hole under the roof is filled.
  // Empty cells on the grid border are the survey's edge and stay nodata.
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
        const d = useReconstructionStore().dem
        if (!d) return null
        let interior = 0
        for (let r = 1; r < d.height - 1; r++)
          for (let c = 1; c < d.width - 1; c++) if (!d.mask[r * d.width + c]) interior++
        return { points: d.points, interior, holes: d.holesFilled > 0, roofGone: d.zMax < 2.5 }
      }),
    )
    .toEqual({ points: 'ground', interior: 0, holes: true, roofGone: true })

  // Points ▸ Classes… ▸ Building alone: a DEM of the roof only.
  await page.evaluate(async () => {
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().demOpen = true
  })
  await dialog.getByLabel('Points').selectOption('classes')
  await dialog.getByLabel('High vegetation').uncheck()
  await dialog.getByLabel('Building').check()
  await dialog.getByRole('button', { name: 'Build DEM', exact: true }).click()
  await expect
    .poll(async () =>
      page.evaluate(async () => {
        const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
        const d = useReconstructionStore().dem
        // The roof alone: about 12 m on a side (the local frame levels on these points).
        return d?.points === 'classes'
          ? { classes: d.classes, roofOnly: d.width * d.gsd < 14 && d.height * d.gsd < 14 }
          : null
      }),
    )
    .toEqual({ classes: [6], roofOnly: true })

  expect(errors).toEqual([])
})
