import { test, expect } from '@playwright/test'
import { stat } from 'node:fs/promises'

// View ▸ Camera ▸ Turntable against the real Viewer3D: the camera circles the scene
// while it is on, and Record one turn saves a video through MediaRecorder.

test('the turntable turns the view and records one turn', async ({ page }) => {
  test.setTimeout(60_000)
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)

  // A small tilted grid, so the view has something to turn around.
  await page.evaluate(async () => {
    const { useReconstructionStore } = await import('/src/stores/useReconstructionStore.js')
    const pos = new Float64Array(300),
      col = new Uint8Array(300).fill(200)
    for (let i = 0; i < 100; i++) {
      pos[i * 3] = i % 10
      pos[i * 3 + 1] = Math.floor(i / 10)
      pos[i * 3 + 2] = (i % 10) * 0.3
    }
    useReconstructionStore().importCloud({ count: 100, pos, col }, 'grid.ply')
  })
  const viewer = page.locator('.viewer')
  await expect.poll(() => viewer.evaluate((el) => el.__vueParentComponent.setupState.cloudLayers.size)).toBe(1)

  // The camera's heading about the scene's up (+Z here), seen from the orbit centre.
  const heading = () =>
    viewer.evaluate((el) => {
      const s = el.__vueParentComponent.setupState
      const t = s.controls.target
      return Math.atan2(s.camera.position.y - t.y, s.camera.position.x - t.x)
    })

  await page.getByRole('button', { name: 'View', exact: true }).click()
  const turntable = page.locator('.ribbon').getByRole('button', { name: 'Turntable' })
  await turntable.click()
  const toolbox = page.locator('.viewer').getByText('Seconds per turn')
  await expect(toolbox).toBeVisible()

  const before = await heading()
  await page.waitForTimeout(800)
  expect(Math.abs((await heading()) - before)).toBeGreaterThan(0.05)

  // A short turn keeps the test quick.
  const seconds = page.locator('.viewer input[type="number"]')
  await seconds.fill('5')
  await seconds.blur()
  const download = page.waitForEvent('download', { timeout: 20_000 })
  await page.getByRole('button', { name: 'Record one turn' }).click()
  await expect(page.getByText(/Recording \d+ %/)).toBeVisible()
  const file = await download
  expect(file.suggestedFilename()).toMatch(/-turntable\.(webm|mp4)$/)
  expect((await stat(await file.path())).size).toBeGreaterThan(1000)
  if (process.env.TURNTABLE_OUT) await file.saveAs(process.env.TURNTABLE_OUT)
  await expect(page.getByRole('button', { name: 'Record one turn' })).toBeVisible()

  // The ribbon button turns it off again, and the view stays where it stopped.
  await turntable.click()
  await expect(toolbox).toHaveCount(0)
  const stopped = await heading()
  await page.waitForTimeout(400)
  expect(Math.abs((await heading()) - stopped)).toBeLessThan(1e-3)
  expect(errors).toEqual([])
})
