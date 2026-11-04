import { test, expect } from './fixtures.js'

// Set Real-World Scale ▸ Mark point in photos hands a scale-bar point to the image view
// (useGcpEditing startMarkingPoint); the Scale bar toolbox (ScaleBarMarkingToolbox.vue)
// shows it over the workspace and leads back to the dialog or stops. And Georeference's
// method cards say on hover why they cannot be chosen (core/stepEffects/georeference.js).

async function newProject(page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  if (await page.locator('.project-backdrop').isVisible()) await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.querySelector('#app')?.__vue_app__?._instance?.setupState)
}

// A new marker handed to marking, with one photo mark. → its name
async function startMarking(page) {
  return page.evaluate(async () => {
    const { useGcpsStore } = await import('/src/stores/useGcpsStore.js')
    const gcps = useGcpsStore()
    const id = gcps.addPoint({ role: 'marker' })
    document.querySelector('#app').__vue_app__._instance.setupState.startMarkingPoint(id)
    gcps.setObservation(id, 'img-1', 'DSC_0012.JPG', 100, 100, null)
    return gcps.gcps.find((g) => g.id === id).name
  })
}

test('the scale bar toolbox shows the point being marked and leads back or stops', async ({ page }) => {
  await newProject(page)
  const name = await startMarking(page)
  const box = page.getByRole('toolbar', { name: 'Scale bar' })
  await expect(box).toContainText(`Marking ${name}`)
  await expect(box).toContainText('Marked in 1 of 2')
  await expect(box).toContainText('DSC_0012.JPG')
  await expect(box).toContainText('Open a photo')

  await box.getByRole('button', { name: 'Back to scale bars' }).click()
  await expect(box).toHaveCount(0)
  await expect(page.getByText('Set Real-World Scale')).toBeVisible()
  await page.keyboard.press('Escape')

  await startMarking(page)
  await box.getByRole('button', { name: 'Stop' }).click()
  await expect(box).toHaveCount(0)
  await expect(page.getByText('Set Real-World Scale')).toHaveCount(0)
})

test('Georeference method cards say why they cannot be chosen', async ({ page }) => {
  await newProject(page)
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const projects = useProjectsStore()
    await projects.setProjectCrs(projects.currentProjectId, 'EPSG:32632')
    const { useModalsStore } = await import('/src/stores/useModalsStore.js')
    useModalsStore().georeferenceOpen = true
  })
  const dialog = page.getByRole('dialog', { name: 'Georeference' })
  await expect(dialog).toContainText('EPSG:32632')
  await expect(dialog.locator('.choice-card[data-id="adjust"]')).toBeDisabled()
  await expect(dialog.locator('.choice-card[data-id="adjust"]')).toHaveAttribute('title', /Match features first/)
  await expect(dialog.locator('.choice-card[data-id="transform"]')).toHaveAttribute('title', /sparse model/)
  await expect(dialog.getByRole('button', { name: 'Georeference', exact: true })).toBeDisabled()
})
