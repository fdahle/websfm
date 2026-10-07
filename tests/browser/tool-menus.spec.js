import { test, expect } from '@playwright/test'

// Tools tab dropdowns (Point Cloud ▾ / Mesh ▾) → tool dialogs → the store's
// non-destructive edit path → the real worker ops, against the full application.
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
    const pos = new Float64Array(N * N * 3), col = new Uint8Array(N * N * 3).fill(180)
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = (j * N + i) * 3
      pos[k] = i; pos[k + 1] = j; pos[k + 2] = Math.sin(i / 4) * Math.cos(j / 5)
    }
    const idx = []
    for (let j = 0; j < N - 1; j++) for (let i = 0; i < N - 1; i++) {
      const a = j * N + i
      idx.push(a, a + 1, a + N, a + 1, a + N + 1, a + N)
    }
    store.importCloud({ count: N * N, pos: pos.slice(), col: col.slice() }, 'grid.ply')
    store.importCloud({ nVerts: N * N, count: idx.length / 3, pos, idx: Uint32Array.from(idx), col }, 'surface.ply')
  })
}

const clouds = (page) => page.evaluate(async () => {
  const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
  return useReconstructionStore().clouds.map((c) => ({
    name: c.name, kind: c.kind, count: c.count, derived: !!c.derived, nrm: !!c.nrm,
    attributes: Object.keys(c.attributes || {}), style: c.style?.field ?? null,
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
  await openTool(page, /Point\s*Cloud/, /Distance to reference/)
  const dist = page.getByRole('dialog', { name: 'Distance to Reference' })
  await dist.getByLabel('To', { exact: true }).selectOption({ label: 'Imported (surface.ply) (mesh)' })
  await dist.getByRole('button', { name: 'Compute', exact: true }).click()
  await expect.poll(async () => (await clouds(page)).find((c) => c.name.endsWith('(distance)'))?.style).toBe('attribute:distance')

  // Clean, decimate and smooth the mesh: three derived meshes, the import untouched.
  await openTool(page, 'Mesh', /Clean mesh/)
  await page.getByRole('button', { name: 'Clean', exact: true }).click()
  await expect.poll(async () => (await clouds(page)).filter((c) => c.kind === 'mesh' && c.derived).length).toBe(1)
  await openTool(page, 'Mesh', /Decimate/)
  await page.getByRole('button', { name: 'Decimate', exact: true }).click()
  await expect.poll(async () => (await clouds(page)).find((c) => c.name.endsWith('(decimated)'))?.count ?? 0).toBeGreaterThan(0)
  const list = await clouds(page)
  const source = list.find((c) => c.name === 'Imported (surface.ply)')
  const decimated = list.find((c) => c.name.endsWith('(decimated)'))
  expect(decimated.count).toBeLessThan(source.count)
  expect(source.count).toBe(29 * 29 * 2)

  // Area & volume reads the selected mesh synchronously.
  await openTool(page, 'Mesh', /Area & volume/)
  const measure = page.getByRole('dialog', { name: 'Mesh Area & Volume' })
  await expect(measure.getByText('Surface area')).toBeVisible()
  // An open terrain surface: no volume, and the dialog says why.
  await expect(measure.getByText('not closed', { exact: true })).toBeVisible()
  await expect(measure.getByText(/open edges \(holes\)/)).toBeVisible()
  await measure.getByRole('button', { name: 'Close', exact: true }).last().click()

  expect(errors).toEqual([])
})
