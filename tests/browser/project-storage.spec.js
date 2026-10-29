import { test, expect } from '@playwright/test'

// Where a project is kept: a project file opened into a folder, and a save that finds
// browser storage full. The "folder" is an OPFS subdirectory: a real
// FileSystemDirectoryHandle, returned by a stubbed showDirectoryPicker (as in
// storage-move.spec.js).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle(`picked-${Date.now()}`, { create: true })
    }
  })
})

test('a project file opened into a folder is unpacked there, never into browser storage', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'folders on disk are Chromium-only')
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByPlaceholder('My Project').fill('Packed')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  // The open project, as a .websfm file in memory.
  await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const { exportProjectArchive } = await import('/src/utils/projectFile.js')
    const { buildManifest } = await import('/src/core/io/projectArchive.js')
    const projects = useProjectsStore()
    const chunks = []
    const openSink = () => ({
      streaming: false,
      write: (c) => chunks.push(c.slice()),
      close: async () => {},
      abort: () => {},
    })
    await exportProjectArchive({
      projectId: projects.currentProjectId,
      manifest: buildManifest({ project: projects.currentProject }),
      fileName: 'packed.websfm',
      openSink,
    })
    window.__packed = new File(chunks, 'packed.websfm')
  })

  // Not awaited: the open waits for the answer below.
  await page.evaluate(() => {
    document.querySelector('#app').__vue_app__._instance.setupState.importProjectFile(window.__packed)
  })
  const ask = page.getByRole('dialog', { name: 'Open project file' })
  await expect(ask).toContainText('Keep it in this browser, or in a folder on your disk?')
  await ask.getByRole('button', { name: 'In a folder…' }).click()
  await expect(page.locator('.toast', { hasText: 'Project opened' })).toBeVisible()

  const where = await page.evaluate(async () => {
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const projects = useProjectsStore()
    const p = projects.currentProject
    const opfs = await import('/src/utils/opfs.js')
    const inBrowser = await opfs
      .getOpfsProjectDir(p.id)
      .then(() => true)
      .catch(() => false)
    const root = await navigator.storage.getDirectory()
    const projectJson = await root
      .getDirectoryHandle(p.folderName ?? '-')
      .then((folder) => folder.getFileHandle('project.json'))
      .then(() => true)
      .catch(() => false)
    return { name: p.name, storage: p.storage, inBrowser, projectJson }
  })
  expect(where).toEqual({ name: 'Packed (imported)', storage: 'folder', inBrowser: false, projectJson: true })
  expect(errors).toEqual([])
})

test('a save that finds browser storage full offers a folder, and is saved there', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  // A save that the browser refuses until the project is in its folder.
  await page.evaluate(async () => {
    const { trackPersistence } = await import('/src/utils/persistence.js')
    const { useProjectsStore } = await import('/src/stores/useProjectsStore.js')
    const projects = useProjectsStore()
    const id = projects.currentProjectId
    window.__save = trackPersistence('test-save', async () => {
      if (!projects.projects.find((p) => p.id === id)?.folderName)
        throw Object.assign(new Error('Storage is full'), { name: 'QuotaExceededError' })
    }).catch(() => {})
  })
  // It asks at once; "Not now" leaves the save on the card, which says why.
  const ask = page.getByRole('dialog', { name: 'Browser storage is full' })
  await expect(ask).toContainText('the last changes could not be saved')
  await ask.getByRole('button', { name: 'Not now' }).click()
  const card = page.getByRole('alert').filter({ hasText: 'Browser storage is full' })
  await expect(card).toContainText('1 change could not be saved')
  await card.getByRole('button', { name: 'Move to folder…' }).click()
  await expect(page.locator('.toast', { hasText: 'Project moved to folder' })).toBeVisible()
  // Retried in the folder after the move: the card goes.
  await expect(card).toHaveCount(0)
  const storage = await page.evaluate(
    async () => (await import('/src/stores/useProjectsStore.js')).useProjectsStore().currentProject.storage,
  )
  expect(storage).toBe('folder')
})
