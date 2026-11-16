// The README's screenshots: what each one shows and how to open it (shoot.mjs takes them).
// `take(page)` opens the view the way a user would, through the ribbon and the sidebar,
// and returns what to capture (shoot.mjs ▸ the shot loop); `after(page)` closes it again.
// Each file keeps its name in docs/images/, so the README needs no change when they are
// taken again.

export const PROJECT_NAME = 'Aukerman Park'

const ribbonTab = (page, name) => page.locator('.ribbon .tab', { hasText: name }).first().click()
const ribbonButton = (page, name) => page.locator('.ribbon').getByRole('button', { name, exact: true }).first().click()
const viewTab = (page, title) => page.locator('.tabstrip .tab', { hasText: title }).click()
const showIn3d = (page, cloud, on) => page.getByRole('checkbox', { name: `Show ${cloud} in 3D` }).setChecked(on)

async function hideConsole(page) {
  if (await page.locator('.console').isVisible()) await page.keyboard.press('Control+Backquote')
}

// Open the Reconstruction and Products sections, each told open by a row of its own.
async function openSidebar(page) {
  for (const [section, row] of [
    [/^reconstruction$/i, 'Sparse cloud'],
    [/^products$/i, 'Dense cloud'],
  ]) {
    if (await page.getByRole('checkbox', { name: `Show ${row} in 3D` }).isVisible()) continue
    await page.locator('.sidebar').getByText(section).first().click()
  }
}

// A dialog alone (and a box over its edge, such as a hover box), with a margin of the
// window around them.
async function around(page, locators, margin = 16) {
  const boxes = await Promise.all([locators].flat().map((l) => l.boundingBox()))
  const x0 = Math.min(...boxes.map((b) => b.x)) - margin
  const y0 = Math.min(...boxes.map((b) => b.y)) - margin
  const x1 = Math.max(...boxes.map((b) => b.x + b.width)) + margin
  const y1 = Math.max(...boxes.map((b) => b.y + b.height)) + margin
  return { clip: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } }
}

export const SHOTS = [
  {
    // The README's first image: one turn of the dense cloud and the cameras, recorded by
    // the 3D view's own Record one turn.
    id: 'turntable',
    animation: { width: 800, height: 400, crop: 0.68, fps: 12, quality: 60 },
    take: async (page, { work }) => {
      await hideConsole(page)
      await openSidebar(page)
      await viewTab(page, '3D')
      await showIn3d(page, 'Mesh (textured)', false)
      await ribbonTab(page, 'View')
      if (
        await page
          .locator('.ribbon')
          .getByRole('button', { name: 'Grid', exact: true })
          .first()
          .evaluate((b) => b.classList.contains('active'))
      )
        await ribbonButton(page, 'Grid')
      await ribbonButton(page, 'Reset View')
      const canvas = page.locator('canvas:visible').first()
      const box = await canvas.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -240)
      await page.waitForTimeout(1500)
      await ribbonButton(page, 'Turntable')
      const download = page.waitForEvent('download', { timeout: 120_000 })
      await page.getByRole('button', { name: 'Record one turn' }).click()
      const video = `${work}/turn.webm`
      await (await download).saveAs(video)
      return { recording: video }
    },
    after: async (page) => {
      await ribbonButton(page, 'Turntable')
      await ribbonButton(page, 'Grid')
      await showIn3d(page, 'Mesh (textured)', true)
    },
  },
  {
    // "What works today": the orthophoto on the satellite basemap, with the cameras.
    id: 'orthophoto',
    take: async (page) => {
      await hideConsole(page)
      await openSidebar(page)
      await viewTab(page, '2D')
      await ribbonTab(page, 'View')
      await ribbonButton(page, 'Basemap')
      await page.locator('[role=menu]').getByText('Satellite', { exact: true }).click()
      await ribbonButton(page, 'Fit View')
      await page.waitForLoadState('networkidle')
      await page.waitForTimeout(4000)
      return page
    },
  },
  {
    // The match graph laid out by camera position, with one pair's matches beside it.
    id: 'matches',
    take: async (page) => {
      await ribbonTab(page, 'View')
      await ribbonButton(page, 'Matches')
      const dialog = page.getByRole('dialog').last()
      await dialog.locator('.view-btn', { hasText: 'List' }).click()
      await dialog.locator('tbody tr').nth(5).click()
      await dialog.locator('.view-btn', { hasText: 'Graph' }).click()
      await page.waitForTimeout(3000)
      return page
    },
    after: (page) => page.keyboard.press('Escape'),
  },
  {
    // A processing dialog: quality cards, then its settings as numbered steps.
    id: 'depth-maps',
    take: async (page) => {
      await ribbonTab(page, 'Reconstruct')
      await ribbonButton(page, 'Depth Maps')
      const dialog = page.getByRole('dialog').last()
      await dialog.waitFor()
      await page.waitForTimeout(800)
      return around(page, dialog)
    },
    after: (page) => page.keyboard.press('Escape'),
  },
  {
    // The Quality Report's overview of the finished project.
    id: 'quality-report',
    take: async (page) => {
      await ribbonTab(page, 'Evaluate')
      await ribbonButton(page, 'Quality Report')
      const dialog = page.getByRole('dialog').last()
      await dialog.waitFor()
      await page.waitForTimeout(1500)
      return around(page, dialog)
    },
    after: (page) => page.keyboard.press('Escape'),
  },
  {
    // The glossary: an article, and a linked term's hover box over it.
    id: 'glossary',
    take: async (page) => {
      await ribbonTab(page, 'Other')
      await ribbonButton(page, 'Glossary')
      const dialog = page.getByRole('dialog', { name: 'Glossary' })
      await dialog.locator('input.search').fill('focal length')
      await dialog.getByText('Focal Length', { exact: true }).first().click()
      await dialog.locator('.glossary-link[data-help-id="camera-intrinsics"]').first().hover()
      const tip = page.locator('.glossary-tooltip').last()
      await tip.waitFor()
      await page.waitForTimeout(500)
      return around(page, [dialog, tip])
    },
    after: (page) => page.keyboard.press('Escape'),
  },
]
