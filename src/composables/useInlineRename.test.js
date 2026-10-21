import { describe, it, expect, vi } from 'vitest'
import { nextTick } from 'vue'
import { useInlineRename } from './useInlineRename.js'
import { useExpandedSet } from './useExpandedSet.js'

describe('useInlineRename', () => {
  it('commits the trimmed name once and focuses the input on start', async () => {
    const onCommit = vi.fn()
    const r = useInlineRename(onCommit)
    const input = { focus: vi.fn(), select: vi.fn() }
    r.setInput(input)
    r.start('a', 'Old')
    await nextTick()
    expect(input.focus).toHaveBeenCalled()
    r.editingName.value = '  New  '
    r.commit()
    r.commit() // the blur after Enter
    expect(onCommit).toHaveBeenCalledOnce()
    expect(onCommit).toHaveBeenCalledWith('a', 'New')
    expect(r.editingId.value).toBeNull()
  })

  it('commits nothing on cancel, even when the input blurs afterwards', () => {
    const onCommit = vi.fn()
    const r = useInlineRename(onCommit)
    r.start('a', 'Old')
    r.editingName.value = 'Changed'
    r.cancel()
    r.commit()
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('ignores an empty name', () => {
    const onCommit = vi.fn()
    const r = useInlineRename(onCommit)
    r.start('a', 'Old')
    r.editingName.value = '   '
    r.commit()
    expect(onCommit).not.toHaveBeenCalled()
  })
})

describe('useExpandedSet', () => {
  it('toggles rows independently and clears', () => {
    const e = useExpandedSet()
    e.toggle('a')
    e.toggle('b')
    e.toggle('a')
    expect(e.isExpanded('a')).toBe(false)
    expect(e.isExpanded('b')).toBe(true)
    e.clear()
    expect(e.isExpanded('b')).toBe(false)
  })
})
