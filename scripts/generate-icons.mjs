// Generate the favicon and the installed-app (PWA) icons from one drawing: two
// camera frustums whose rays meet at a reconstructed point (triangulation).
// The outputs are committed; rerun after changing the geometry or colours here:
//
//   PLAYWRIGHT_CHANNEL=chrome node scripts/generate-icons.mjs
//
// (or run `npx playwright install chromium` once and omit the channel).
//
//   public/favicon.svg            browser tab: transparent, switches ink with the
//                                 browser's light/dark theme via a media query
//   public/favicon-32.png         the light-theme favicon, for browsers without SVG favicons
//   public/apple-touch-icon.png   iOS home screen: opaque, iOS rounds the corners itself
//   public/icons/icon-*.png       manifest `any`: the rounded dark tile (desktop docks)
//   public/icons/maskable-512.png manifest `maskable`: full-bleed, art in the 80 % safe circle
//
// Home screens fill transparency with black or white, so every installed-app icon
// keeps the dark tile; only the tab favicon is transparent.
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const C = { tile: '#171a21', g0: '#4f8cff', g1: '#7657e8', white: '#ffffff', hot: '#ffc857', hotLight: '#f29a0c' }

const f = (n) => +n.toFixed(2)
const pts = (list) => list.map((p) => p.map(f).join(',')).join(' ')

// A 2D camera frustum: apex at the camera centre, opening `len` units toward `target`.
function wedge([ax, ay], [tx, ty], len, half) {
  const dx = tx - ax,
    dy = ty - ay,
    L = Math.hypot(dx, dy)
  const ux = dx / L,
    uy = dy / L,
    px = -uy,
    py = ux
  const cx = ax + ux * len,
    cy = ay + uy * len
  return {
    poly: [
      [ax, ay],
      [cx + px * half, cy + py * half],
      [cx - px * half, cy - py * half],
    ],
    plane: [cx, cy],
  }
}

const GRADIENT =
  `<defs><linearGradient id="g" x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">` +
  `<stop stop-color="${C.g0}"/><stop offset="1" stop-color="${C.g1}"/></linearGradient></defs>`

// The drawing on a 64-unit canvas. `ink`/`hot` are attribute strings, so the
// favicon can pass classes instead of colours.
function triangulation({ ink, hot, rayOpacity = 0.6, r = 5, len = 20, half = 8 }) {
  const P = [32, 15],
    a = wedge([10, 52], P, len, half),
    b = wedge([54, 52], P, len, half)
  const ray = (w) =>
    `<line x1="${f(w.plane[0])}" y1="${f(w.plane[1])}" x2="${P[0]}" y2="${P[1]}" ${ink} stroke-opacity="${rayOpacity}" stroke-width="2" stroke-linecap="round"/>`
  const cam = (w) =>
    `<polygon points="${pts(w.poly)}" fill="url(#g)" ${ink} stroke-width="2.5" stroke-linejoin="round"/>`
  return (
    `${ray(a)}${ray(b)}${cam(a)}${cam(b)}` +
    `<circle cx="32" cy="15" r="${r + 4}" ${hot} fill-opacity=".22"/><circle cx="32" cy="15" r="${r}" ${hot}/>`
  )
}

const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${GRADIENT}${body}</svg>\n`
const scaled = (s, cy, art) => `<g transform="translate(32 ${cy}) scale(${s}) translate(-32 -${cy})">${art}</g>`

// Without a tile to frame it, the open shape reads small in a tab: bigger
// cameras and point, scaled to use the whole canvas.
const TAB = { len: 23, half: 9, r: 6 }
const tabArt = (ink, hot, rayOpacity) => scaled(1.2, 30, triangulation({ ink, hot, rayOpacity, ...TAB }))

const favicon = svg(
  `<style>.ink{stroke:${C.tile}}.ray{stroke-opacity:.45}.pt{fill:${C.hotLight}}` +
    `@media (prefers-color-scheme:dark){.ink{stroke:${C.white}}.ray{stroke-opacity:.6}.pt{fill:${C.hot}}}</style>` +
    tabArt('class="ink"', 'class="pt"', 0.45).replace(/class="ink" stroke-opacity="0.45"/g, 'class="ink ray"'),
)
const faviconLight = svg(tabArt(`stroke="${C.tile}"`, `fill="${C.hotLight}"`, 0.45))

const appArt = triangulation({ ink: `stroke="${C.white}"`, hot: `fill="${C.hot}"` })
const tile = svg(`<rect width="64" height="64" rx="14" fill="${C.tile}"/>${appArt}`)
const fullBleed = (s) => svg(`<rect width="64" height="64" fill="${C.tile}"/>${scaled(s, 32, appArt)}`)

const OUT = new URL('../public/', import.meta.url)
const PNGS = [
  ['favicon-32.png', faviconLight, 32],
  ['apple-touch-icon.png', fullBleed(0.86), 180],
  ['icons/icon-192.png', tile, 192],
  ['icons/icon-512.png', tile, 512],
  ['icons/maskable-512.png', fullBleed(0.78), 512],
]

await mkdir(new URL('icons/', OUT), { recursive: true })
await writeFile(new URL('favicon.svg', OUT), favicon)

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  for (const [file, source, size] of PNGS) {
    await page.setViewportSize({ width: size, height: size })
    const sized = source.replace('<svg ', `<svg width="${size}" height="${size}" `)
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`)
    await writeFile(
      new URL(file, OUT),
      await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }),
    )
    console.log(`wrote public/${file} (${size}×${size})`)
  }
} finally {
  await browser.close()
}
console.log('wrote public/favicon.svg')
