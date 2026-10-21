import { orthoFilterSteps } from '../core/products/productStyle.js'

// An orthophoto's brightness/contrast/gamma (core/products/productStyle.js) as a
// CSS `filter` value for its preview image — the <img> in the product tab, and the
// map's static preview layer (canvas `filter`). The GPU tiles get the same maths as
// WebGLTile style entries; CSS has no gamma filter, so this is an SVG
// <feComponentTransfer> chain, in sRGB (the shader works on the stored values, not
// linear light). → null when the style is neutral.
//
// One hidden <svg> holds a <filter> per distinct style, keyed by its values, so any
// number of viewers share one definition and a restyle only adds a new one.
const SVG_NS = 'http://www.w3.org/2000/svg'
let root = null

function filterRoot() {
  if (root?.isConnected) return root
  root = document.createElementNS(SVG_NS, 'svg')
  root.setAttribute('aria-hidden', 'true')
  // Not display:none — a filter inside an undisplayed <svg> is not rendered.
  root.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none')
  root.appendChild(document.createElementNS(SVG_NS, 'defs'))
  document.body.appendChild(root)
  return root
}

export function orthoAdjustFilter(style) {
  const steps = orthoFilterSteps(style)
  if (!steps.length || typeof document === 'undefined') return null
  const key = steps
    .map((s) => Object.values(s).join('_'))
    .join('-')
    .replace(/[^\w-]/g, (c) => (c === '.' ? 'p' : 'm'))
  const id = `ortho-adjust-${key}`
  if (!document.getElementById(id)) {
    const filter = document.createElementNS(SVG_NS, 'filter')
    filter.setAttribute('id', id)
    filter.setAttribute('color-interpolation-filters', 'sRGB')
    for (const step of steps) {
      const transfer = document.createElementNS(SVG_NS, 'feComponentTransfer')
      for (const channel of ['feFuncR', 'feFuncG', 'feFuncB']) {
        const fn = document.createElementNS(SVG_NS, channel)
        for (const [k, v] of Object.entries(step)) fn.setAttribute(k, String(v))
        transfer.appendChild(fn)
      }
      filter.appendChild(transfer)
    }
    filterRoot().firstChild.appendChild(filter)
  }
  return `url(#${id})`
}
