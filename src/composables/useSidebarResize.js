import { ref, watch } from 'vue'

// Sidebar width + drag-to-resize, persisted to localStorage. Self-contained:
// the caller binds `sidebarWidth` to the layout and `startSidebarResize` to the
// resize handle's mousedown.
export function useSidebarResize() {
  const sidebarWidth = ref(Number(localStorage.getItem('sidebarWidth')) || 220)
  watch(sidebarWidth, (w) => localStorage.setItem('sidebarWidth', w))
  let sidebarDrag = null
  function startSidebarResize(e) {
    sidebarDrag = { x: e.clientX, w: sidebarWidth.value }
    window.addEventListener('mousemove', onSidebarResize)
    window.addEventListener('mouseup', endSidebarResize)
  }
  function onSidebarResize(e) {
    if (!sidebarDrag) return
    sidebarWidth.value = Math.max(160, Math.min(520, sidebarDrag.w + (e.clientX - sidebarDrag.x)))
  }
  function endSidebarResize() {
    sidebarDrag = null
    window.removeEventListener('mousemove', onSidebarResize)
    window.removeEventListener('mouseup', endSidebarResize)
  }
  return { sidebarWidth, startSidebarResize }
}
