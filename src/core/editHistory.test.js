import { describe, it, expect } from 'vitest'
import { createEditHistory } from './editHistory.js'

const e = (label, bytes = 0) => ({ label, bytes })

describe('edit history', () => {
  it('undoes the last edit first, and redoes what was undone', () => {
    const h = createEditHistory()
    h.record(e('a'))
    h.record(e('b'))
    expect(h.peek()).toEqual({ undo: 'b', redo: null })
    const b = h.takeUndo()
    expect(b.label).toBe('b')
    h.undone(e('b back'))
    expect(h.peek()).toEqual({ undo: 'a', redo: 'b back' })
    const again = h.takeRedo()
    h.redone(e('b again'))
    expect(again.label).toBe('b back')
    expect(h.peek()).toEqual({ undo: 'b again', redo: null })
  })

  it('forgets what could be redone once a new edit is made', () => {
    const h = createEditHistory()
    h.record(e('a'))
    h.undone(h.takeUndo())
    h.record(e('c'))
    expect(h.peek()).toEqual({ undo: 'c', redo: null })
    expect(h.takeRedo()).toBeNull()
  })

  it('keeps at most maxEntries steps, dropping the oldest', () => {
    const h = createEditHistory({ maxEntries: 3 })
    for (const l of ['a', 'b', 'c', 'd', 'e']) h.record(e(l))
    expect(h.size.undo).toBe(3)
    expect([h.takeUndo(), h.takeUndo(), h.takeUndo(), h.takeUndo()].map((x) => x?.label ?? null)).toEqual([
      'e',
      'd',
      'c',
      null,
    ])
  })

  it('keeps what it holds under maxBytes, but always the last step', () => {
    const h = createEditHistory({ maxBytes: 100 })
    h.record(e('a', 60))
    h.record(e('b', 60))
    expect(h.size).toEqual({ undo: 1, redo: 0, bytes: 60 })
    expect(h.peek().undo).toBe('b')
    // One step over the cap on its own is still kept: the last edit can always be undone.
    h.record(e('huge', 500))
    expect(h.peek().undo).toBe('huge')
    expect(h.size.undo).toBe(1)
  })

  it('drops the entries of a removed cloud, and clears', () => {
    const h = createEditHistory()
    h.record({ label: 'a', cloudId: 1 })
    h.record({ label: 'b', cloudId: 2 })
    h.filter((x) => x.cloudId !== 2)
    expect(h.peek().undo).toBe('a')
    h.clear()
    expect(h.peek()).toEqual({ undo: null, redo: null })
  })
})
