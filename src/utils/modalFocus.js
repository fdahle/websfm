// One focus owner for both legacy dialogs and ModalShell, including teleported
// and nested dialogs. Background elements are inert only while a modal is open.
export function installModalFocus(doc = document) {
  const selector = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]'
  const controls = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]'
  const visible = el => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
  const focusables = dialog => [...dialog.querySelectorAll(controls)]
    .filter(el => !el.disabled && el.tabIndex >= 0 && visible(el) && !el.closest('[inert]'))
  const known = new Map(), inert = new Map()
  let top = null
  const restoreInert = () => { for (const [el, value] of inert) el.inert = value; inert.clear() }
  const focusInitial = dialog => {
    const items = focusables(dialog)
    const initial = items.find(el => el.hasAttribute('autofocus'))
      ?? items.find(el => el.matches('.modal-body input, .modal-body select, .modal-body textarea, .modal-footer button'))
      ?? items[0] ?? dialog
    if (!dialog.hasAttribute('tabindex')) dialog.tabIndex = -1
    initial.focus({ preventScroll: true })
  }
  const layer = el => {
    let z = 0
    for (let node = el; node && node !== doc.body; node = node.parentElement) {
      z = Math.max(z, Number.parseInt(getComputedStyle(node).zIndex) || 0)
    }
    return z
  }
  const update = () => {
    const dialogs = [...doc.querySelectorAll(selector)].filter(visible)
    for (const dialog of dialogs) if (!known.has(dialog)) known.set(dialog, doc.activeElement)
    const previous = top
    // Stable order for equal layers; highest overlay is the keyboard owner.
    top = dialogs.sort((a, b) => layer(a) - layer(b)).at(-1) ?? null
    const returnTarget = previous && !dialogs.includes(previous) ? known.get(previous) : null
    for (const dialog of known.keys()) if (!dialogs.includes(dialog)) known.delete(dialog)
    restoreInert()
    if (top) {
      for (let node = top; node.parentElement && node !== doc.body; node = node.parentElement) {
        for (const sibling of node.parentElement.children) if (sibling !== node) {
          inert.set(sibling, sibling.inert)
          sibling.inert = true
        }
      }
    }
    if (top !== previous) {
      if (returnTarget?.isConnected && (!top || top.contains(returnTarget)) && visible(returnTarget)) returnTarget.focus()
      else if (top) focusInitial(top)
    } else if (top && !top.contains(doc.activeElement)) focusInitial(top)
  }
  const onKey = event => {
    if (!top || event.key !== 'Tab') return
    const items = focusables(top)
    const index = items.indexOf(doc.activeElement)
    if (!items.length) { event.preventDefault(); top.focus(); return }
    if (event.shiftKey ? index <= 0 : index < 0 || index === items.length - 1) {
      event.preventDefault()
      items[event.shiftKey ? items.length - 1 : 0].focus()
    }
  }
  const onFocus = event => { if (top && !top.contains(event.target)) focusInitial(top) }
  const observer = new MutationObserver(update)
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-modal'] })
  doc.addEventListener('keydown', onKey, true)
  doc.addEventListener('focusin', onFocus, true)
  update()
  return () => {
    observer.disconnect(); restoreInert()
    doc.removeEventListener('keydown', onKey, true)
    doc.removeEventListener('focusin', onFocus, true)
  }
}
