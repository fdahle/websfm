import { test, expect } from './fixtures.js'

// Duplicate in the project list: a browser project is copied into browser storage, a
// folder project into a folder you pick (a real OPFS subdirectory handle, returned by a
// stubbed showDirectoryPicker, as in project-storage.spec.js). The copy opens with the
// original's data, under its own id, and changing it leaves the original alone.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle(`picked-${Date.now()}`, { create: true })
    }
  })
})

async function addCloud(page) {
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { flushPersistence } = await import('/src/utils/persistence.js')
    useReconstructionStore().importCloud({ count: 2, pos: new Float64Array([0, 0, 0, 1, 1, 1]) }, 'kept.laz')
    await flushPersistence()
  })
}

const cloudNames = (page) =>
  page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    return useReconstructionStore().clouds.map((c) => c.name)
  })

async function duplicateFromPicker(page, name, label) {
  await page.getByRole('button', { name: `${name} ▾`, exact: true }).click()
  const picker = page.locator('.project-picker')
  await picker.locator('.project-item').filter({ hasText: name }).first().click({ button: 'right' })
  await page.getByRole('button', { name: label, exact: true }).click()
  await expect(page.locator('.toast', { hasText: 'Project duplicated' })).toBeVisible()
}

test('a browser project duplicates into browser storage and the copy opens on its own', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByPlaceholder('My Project').fill('Survey')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await addCloud(page)

  await duplicateFromPicker(page, 'Survey', 'Duplicate')
  const listed = await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const p = useProjectsStore()
    return { names: p.projects.map((x) => x.name), current: p.currentProject.name }
  })
  expect(listed).toEqual({ names: ['Survey', 'Survey (copy)'], current: 'Survey' })

  // The list stays open with the copy in it. Open the copy: it has the cloud, and it is
  // a project of its own.
  await expect(page.locator('.project-picker')).toBeVisible()
  await page
    .locator('.project-picker .project-item')
    .filter({ hasText: 'Survey (copy)' })
    .locator('.project-main')
    .click()
  await expect(page.getByRole('button', { name: 'Survey (copy) ▾', exact: true })).toBeVisible()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect.poll(() => cloudNames(page)).toEqual(['Imported (kept.laz)'])
  const stamped = await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const opfs = await import('/src/utils/opfs.js')
    const p = useProjectsStore()
    const data = await opfs.readProject(p.currentProjectId)
    return { idMatches: data.id === p.currentProjectId, name: data.name }
  })
  expect(stamped).toEqual({ idMatches: true, name: 'Survey (copy)' })

  // A change in the copy stays there.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const { flushPersistence } = await import('/src/utils/persistence.js')
    const store = useReconstructionStore()
    store.importCloud({ count: 2, pos: new Float64Array([0, 0, 0, 2, 2, 2]) }, 'copy-only.laz')
    await flushPersistence()
  })
  await page.getByRole('button', { name: 'Survey (copy) ▾', exact: true }).click()
  await page
    .locator('.project-picker .project-item')
    .filter({ hasText: 'Survey', hasNotText: 'copy' })
    .locator('.project-main')
    .click()
  await expect(page.getByRole('button', { name: 'Survey ▾', exact: true })).toBeVisible()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await expect.poll(() => cloudNames(page)).toEqual(['Imported (kept.laz)'])
  expect(errors).toEqual([])
})

test('a folder project duplicates into a folder you pick', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'folders on disk are Chromium-only')
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByPlaceholder('My Project').fill('On disk')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  // Into a folder, the way the menu moves it there.
  await page.getByRole('button', { name: 'On disk ▾', exact: true }).click()
  await page.locator('.project-picker .project-item').filter({ hasText: 'On disk' }).click({ button: 'right' })
  await page.getByRole('button', { name: 'Move to folder…', exact: true }).click()
  await expect(page.locator('.toast', { hasText: 'Project moved to folder' })).toBeVisible()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await addCloud(page)

  await duplicateFromPicker(page, 'On disk', 'Duplicate…')
  const copy = await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const p = useProjectsStore().projects.find((x) => x.name === 'On disk (copy)')
    const root = await navigator.storage.getDirectory()
    const folder = await root.getDirectoryHandle(p.folderName)
    const json = JSON.parse(await (await (await folder.getFileHandle('project.json')).getFile()).text())
    return { storage: p.storage, id: json.id === p.id, name: json.name }
  })
  expect(copy).toEqual({ storage: 'folder', id: true, name: 'On disk (copy)' })
  expect(errors).toEqual([])
})
