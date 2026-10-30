import { test, expect } from './fixtures.js'

// A run left alone (useRunAttention): wake lock while running, the state in the tab
// title, a notification from a hidden tab, and a toast when a stage logged errors.
// The wake lock and Notification are stubbed so the test sees every call, and the
// tab's visibility is switchable.
test('a running workflow holds a wake lock, titles the tab and notifies from a hidden tab', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => {
    localStorage.setItem('consoleOpen', 'false')
    localStorage.setItem('websfm.ui.notifyWhenDone', 'true')
    window.__calls = []
    window.__visible = true
    Object.defineProperty(document, 'visibilityState', { get: () => (window.__visible ? 'visible' : 'hidden') })
    Object.defineProperty(navigator, 'wakeLock', {
      value: {
        request: async (type) => {
          window.__calls.push(`lock ${type}`)
          const target = new EventTarget()
          target.release = async () => {
            window.__calls.push('release')
            target.dispatchEvent(new Event('release'))
          }
          return target
        },
      },
    })
    window.Notification = class {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      constructor(title, opts) {
        window.__calls.push(`notify ${title} | ${opts?.body ?? ''}`)
      }
      close() {}
    }
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const base = await page.title()
  const calls = () => page.evaluate(() => window.__calls)

  // A workflow paused on an interactive block, started from a hidden tab.
  await page.evaluate(async () => {
    const { useWorkflowsStore } = await import('/src/stores/useWorkflowsStore.js')
    const { createWorkflow } = await import('/src/core/workflow.js')
    useWorkflowsStore().addWorkflow(createWorkflow('Review only', ['eval-overview']))
  })
  await page.locator('body').click({ position: { x: 5, y: 300 } })
  await page.keyboard.press('Control+k')
  const prompt = page.locator('.prompt-input')
  const type = async (line) => {
    await prompt.fill(line)
    await prompt.press('Enter')
  }
  await page.evaluate(() => {
    window.__visible = false
  })
  await type('run workflow review')
  await expect(page.locator('.console-body')).toContainText('Workflow waiting: Quality Report needs your input.')
  await expect(page).toHaveTitle(`Waiting for you · ${base}`)
  await expect.poll(calls).toContain('notify A workflow is waiting for you | Quality Report needs your input.')
  // Hidden: no lock yet (the browser would drop it). Visible again: taken.
  expect(await calls()).not.toContain('lock screen')
  await page.evaluate(() => {
    window.__visible = true
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect.poll(calls).toContain('lock screen')

  await page.keyboard.press('Escape')
  await prompt.click()
  await type('continue')
  await expect(page.locator('.console-body')).toContainText('Workflow complete: Review only')
  await expect(page).toHaveTitle(base)
  await expect.poll(calls).toContain('release')
  expect(errors).toEqual([])
})

test('a stage that logs an error raises a toast that opens the console', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const base = await page.title()
  // Through the export progress contract: the same modal, lastRun and log sink.
  const progress = `document.querySelector('#app').__vue_app__._instance.setupState.exportProgress`
  await page.evaluate(`${progress}.open('Exporting Cloud', 4); ${progress}.report(1, 4)`)
  await expect(page).toHaveTitle(`25% · Exporting Cloud · ${base}`)
  await page.evaluate(async (p) => {
    const { useLog } = await import('/src/composables/useLog.js')
    useLog().log('Export error: disk full', 'error', 'Export')
    await new Function(`return ${p}`)().close(false)
  }, progress)
  await expect(page).toHaveTitle(base)
  const toast = page.locator('.toast.error')
  await expect(toast).toContainText('Exporting Cloud: an error')
  await expect(toast).toContainText('Export error: disk full')
  await toast.click()
  await expect(page.locator('.prompt-input')).toBeVisible()
})
