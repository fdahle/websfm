import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeTopModal, openModalCount, pushModal } from './useModalStack.js'

describe('modal stack', () => {
  it('Escape closes the newest modal first, then the one under it', () => {
    const closed = []
    const offA = pushModal(() => closed.push('a'))
    const offB = pushModal(() => closed.push('b'))
    expect(closeTopModal()).toBe(true)
    expect(closed).toEqual(['b'])
    offB() // B unmounts on its close
    expect(closeTopModal()).toBe(true)
    expect(closed).toEqual(['b', 'a'])
    offA()
    expect(openModalCount()).toBe(0)
    expect(closeTopModal()).toBe(false)
  })

  it('a modal closed out of order leaves the others in place', () => {
    const closed = []
    const offA = pushModal(() => closed.push('a'))
    const offB = pushModal(() => closed.push('b'))
    offA()
    offA() // taking it off twice is harmless
    closeTopModal()
    expect(closed).toEqual(['b'])
    offB()
    expect(openModalCount()).toBe(0)
  })

  it('a blocking modal on top uses up Escape without closing the one under it', () => {
    const closed = []
    const offA = pushModal(() => closed.push('a'))
    const offB = pushModal(() => {}) // a non-dismissible shell ignores its close
    expect(closeTopModal()).toBe(true)
    expect(closed).toEqual([])
    offB()
    offA()
  })
})

// Every dialog must be on the stack, or Escape with the focus outside it does nothing
// (or closes the dialog underneath). ModalShell registers itself; anything else that
// draws a modal overlay calls useModalStackEntry.
it('every modal component is on the modal stack', () => {
  const root = fileURLToPath(new URL('../components', import.meta.url))
  const files = []
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (p.endsWith('.vue')) files.push(p)
    }
  }
  walk(root)
  // A run is cancelled with its button, never by Escape; the mobile gate is dismissed
  // only by its button, on purpose.
  const exempt = new Set(['modals/app/ProgressModal.vue', 'layout/MobileWarning.vue'])
  const modal = (src, rel) => /(Modal|Dialog)\.vue$/.test(rel) || /aria-modal|<div[^>]*class="overlay"/.test(src)
  const missing = files
    .map((p) => [relative(root, p).replaceAll('\\', '/'), readFileSync(p, 'utf8')])
    .filter(([rel, src]) => !exempt.has(rel) && modal(src, rel))
    .filter(([, src]) => !/<ModalShell\b|useModalStackEntry\(/.test(src))
    .map(([rel]) => rel)
  expect(files.length).toBeGreaterThan(50)
  expect(missing).toEqual([])
})
