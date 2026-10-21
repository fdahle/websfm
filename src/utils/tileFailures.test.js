import { describe, expect, it } from 'vitest'
import { watchTileFailures } from './tileFailures.js'

function fakeSource() {
  const listeners = {}
  return {
    on(type, fn) {
      ;(listeners[type] ??= []).push(fn)
    },
    emit(type) {
      for (const fn of listeners[type] ?? []) fn()
    },
  }
}

describe('watchTileFailures', () => {
  function setup() {
    const source = fakeSource()
    const changes = []
    let t = 0
    watchTileFailures(source, (v) => changes.push(v), { threshold: 3, windowMs: 1000, now: () => t })
    return {
      source,
      changes,
      advance: (ms) => {
        t += ms
      },
    }
  }

  it('reports failing after enough errors within the window', () => {
    const { source, changes } = setup()
    source.emit('tileloaderror')
    source.emit('tileloaderror')
    expect(changes).toEqual([])
    source.emit('tileloaderror')
    expect(changes).toEqual([true])
  })

  it('stays failing while cached tiles keep loading between errors', () => {
    const { source, changes, advance } = setup()
    for (let i = 0; i < 3; i++) {
      source.emit('tileloaderror')
      source.emit('tileloadend')
      advance(100)
    }
    source.emit('tileloadend')
    expect(changes).toEqual([true])
  })

  it('clears at the first success after a quiet window', () => {
    const { source, changes, advance } = setup()
    for (let i = 0; i < 3; i++) source.emit('tileloaderror')
    advance(1000)
    source.emit('tileloadend')
    expect(changes).toEqual([true, false])
  })

  it('ignores errors spread out beyond the window', () => {
    const { source, changes, advance } = setup()
    for (let i = 0; i < 5; i++) {
      source.emit('tileloaderror')
      advance(600)
    }
    expect(changes).toEqual([])
  })
})
