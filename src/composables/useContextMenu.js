import { ref, onMounted, onBeforeUnmount } from 'vue'

// Shared right-click context-menu behaviour for the sidebar sections. Each menu
// owner (image / sensor / cloud rows) gets its own reactive `menu` ref but they
// coordinate through a module-level registry so opening one closes the others
// (mutual exclusion), and a single document-level `click` listener dismisses any
// open menu — exactly the behaviour the monolithic Sidebar had before the split.
const closers = new Set()
let docBound = false
function closeAll() { for (const c of closers) c() }

export function useContextMenu() {
  const menu = ref(null) // { x, y, …payload } | null
  const close = () => { menu.value = null }

  // Open at the cursor, closing any other open menu first. ContextMenu.vue keeps
  // it on screen by its measured size.
  function open(e, payload = {}) {
    e.preventDefault()
    closeAll()
    menu.value = { x: e.clientX, y: e.clientY, ...payload }
  }

  onMounted(() => {
    closers.add(close)
    if (!docBound) { document.addEventListener('click', closeAll); docBound = true }
  })
  onBeforeUnmount(() => { closers.delete(close) })

  return { menu, open, close }
}
