import { describe, it, expect } from 'vitest'
import { isModalOpen, isTypingTarget, viewerMayHandleKey, MODAL_SELECTOR } from './keyRouting.js'

// A stand-in document: querySelectorAll answers the modal selector with the given
// elements (each "rendered" unless it says otherwise).
const dialog = ({ rendered = true } = {}) => ({ getClientRects: () => (rendered ? [{}] : []) })
const fakeDoc = (dialogs = []) => ({
  querySelectorAll: (sel) => { expect(sel).toBe(MODAL_SELECTOR); return dialogs },
})
const key = (k, { target = { tagName: 'CANVAS' }, defaultPrevented = false } = {}) => ({ key: k, target, defaultPrevented })

describe('isModalOpen', () => {
  it('is false with no dialog, true with a rendered one', () => {
    expect(isModalOpen(fakeDoc())).toBe(false)
    expect(isModalOpen(fakeDoc([dialog()]))).toBe(true)
  })
  it('ignores a dialog that is in the DOM but not laid out', () => {
    expect(isModalOpen(fakeDoc([dialog({ rendered: false })]))).toBe(false)
    expect(isModalOpen(fakeDoc([dialog({ rendered: false }), dialog()]))).toBe(true)
  })
  it('is false without a document (node, SSR)', () => {
    expect(isModalOpen(null)).toBe(false)
    expect(isModalOpen({})).toBe(false)
  })
  it('matches what the focus trap treats as modal', () => {
    expect(MODAL_SELECTOR).toContain('[role="dialog"][aria-modal="true"]')
    expect(MODAL_SELECTOR).toContain('[role="alertdialog"][aria-modal="true"]')
  })
})

describe('isTypingTarget', () => {
  it('recognises text fields, selects and contenteditable', () => {
    for (const tagName of ['INPUT', 'TEXTAREA', 'SELECT']) expect(isTypingTarget({ tagName })).toBe(true)
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
  })
  it('treats buttons, canvases and the body as not typing', () => {
    for (const tagName of ['BUTTON', 'CANVAS', 'BODY']) expect(isTypingTarget({ tagName })).toBe(false)
    expect(isTypingTarget(null)).toBe(false)
  })
})

describe('viewerMayHandleKey', () => {
  it('lets a viewer act on a free key with no dialog open', () => {
    expect(viewerMayHandleKey(key('Escape'), fakeDoc())).toBe(true)
    expect(viewerMayHandleKey(key('Delete'), fakeDoc())).toBe(true)
  })
  it('never acts while a dialog is open — Escape belongs to the dialog', () => {
    expect(viewerMayHandleKey(key('Escape'), fakeDoc([dialog()]))).toBe(false)
  })
  it('never deletes while a dialog is open, even with focus on its button', () => {
    for (const k of ['Delete', 'Backspace']) {
      expect(viewerMayHandleKey(key(k, { target: { tagName: 'BUTTON' } }), fakeDoc([dialog()]))).toBe(false)
    }
  })
  it('leaves keys typed into a field to the field', () => {
    expect(viewerMayHandleKey(key('Backspace', { target: { tagName: 'INPUT' } }), fakeDoc())).toBe(false)
  })
  it('skips a key a more specific handler already consumed', () => {
    expect(viewerMayHandleKey(key('Escape', { defaultPrevented: true }), fakeDoc())).toBe(false)
  })
})

// The routing contract end to end, with the real listeners' shape: viewers run
// first (children register first) and consume what they act on; App's global
// handler skips consumed events. One Escape does one thing, innermost first.
describe('Escape routing between a viewer and App', () => {
  function dispatch(e, listeners) { for (const l of listeners) l(e) }
  function makeEvent(k, opts) {
    const e = { ...key(k, opts) }
    e.preventDefault = () => { e.defaultPrevented = true }
    return e
  }
  function setup({ modal = false, selection = true } = {}) {
    const doc = fakeDoc(modal ? [dialog()] : [])
    const state = { selection, modal, tool: true }
    const viewer = (e) => {
      if (!viewerMayHandleKey(e, doc)) return
      if (e.key === 'Escape' && state.selection) { e.preventDefault(); state.selection = false }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && state.selection) { e.preventDefault(); state.deleted = true }
    }
    const app = (e) => {
      if (e.defaultPrevented) return
      if (e.key === 'Escape') { if (state.modal) state.modal = false; else state.tool = false }
    }
    return { state, run: (k, o) => dispatch(makeEvent(k, o), [viewer, app]) }
  }

  it('with a modal open, Escape closes only the modal', () => {
    const { state, run } = setup({ modal: true })
    run('Escape')
    expect(state).toMatchObject({ modal: false, selection: true, tool: true })
  })
  it('with no modal, Escape clears the selection and keeps the tool', () => {
    const { state, run } = setup()
    run('Escape')
    expect(state).toMatchObject({ selection: false, tool: true })
    run('Escape')
    expect(state.tool).toBe(false)
  })
  it('Delete in a confirm dialog never deletes the selected points', () => {
    const { state, run } = setup({ modal: true })
    run('Delete', { target: { tagName: 'BUTTON' } })
    run('Backspace', { target: { tagName: 'BUTTON' } })
    expect(state.deleted).toBeUndefined()
    expect(state.selection).toBe(true)
  })
})
