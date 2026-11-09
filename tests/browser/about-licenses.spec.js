import { test, expect } from './fixtures.js'

// About ▸ Licenses loads the third-party notices (scripts/licenses/, served by the dev
// server as a build writes them): the npm packages, the Rust crates, the hand-kept code,
// models and data, each license text in a fold that renders when opened.

test('About ▸ Licenses lists the third-party notices with their texts', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.addInitScript(() => localStorage.setItem('consoleOpen', 'false'))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  await page.getByText('Other', { exact: true }).first().click()
  await page.getByRole('button', { name: /About/ }).first().click()
  await page.getByRole('button', { name: 'Licenses', exact: true }).click()

  const heads = page.locator('.group-head')
  await expect(heads.first()).toContainText('JavaScript packages')
  await expect(heads).toContainText([/JavaScript packages/, /Rust crates/, /own source/, /Learned models/, /Data/])
  const item = (name) => page.locator('.lic-item').filter({ has: page.locator('.lic-name', { hasText: name }) })
  await expect(item('Rust standard library')).toBeVisible()
  await expect(item('EPSG Geodetic Parameter Dataset')).toContainText('owned by IOGP')

  // A fold renders its text only once opened.
  const vue = item('vue').first()
  await expect(vue.locator('pre')).toHaveCount(0)
  await vue.locator('summary').click()
  await expect(vue.locator('pre')).toContainText('Permission is hereby granted')
  expect(errors).toEqual([])
})
