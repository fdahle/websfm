import { describe, it, expect } from 'vitest'
import { createGeneration } from './generation.js'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

// The shape of ViewerMap's build(): await a projection, then create the map only
// if this build is still the newest.
function harness() {
  const gen = createGeneration()
  const created = []
  async function build(name, wait) {
    const token = gen.next()
    if (wait) await wait
    if (!gen.isCurrent(token)) return
    created.push(name)
  }
  return { gen, created, build }
}

describe('createGeneration', () => {
  it('only the newest token is current', () => {
    const g = createGeneration()
    const a = g.next()
    expect(g.isCurrent(a)).toBe(true)
    const b = g.next()
    expect(g.isCurrent(a)).toBe(false)
    expect(g.isCurrent(b)).toBe(true)
    g.invalidate()
    expect(g.isCurrent(b)).toBe(false)
  })

  it('overlapping builds create one map: the newest', async () => {
    const { created, build } = harness()
    const first = deferred(), second = deferred()
    const a = build('crs A', first.promise)
    const b = build('crs B', second.promise)
    second.resolve(); first.resolve()
    await Promise.all([a, b])
    expect(created).toEqual(['crs B'])
  })

  it('an older CRS build resolving late does not replace a newer model-frame build', async () => {
    const { created, build } = harness()
    const slow = deferred()
    const a = build('crs', slow.promise)
    await build('model') // no await inside: the model frame needs no projection load
    slow.resolve()
    await a
    expect(created).toEqual(['model'])
  })

  it('unmount mid-build (invalidate) creates nothing', async () => {
    const { gen, created, build } = harness()
    const slow = deferred()
    const a = build('crs', slow.promise)
    gen.invalidate()
    slow.resolve()
    await a
    expect(created).toEqual([])
  })
})
