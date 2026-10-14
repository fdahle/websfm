import { nextTick, ref, watch } from 'vue'

const MARGIN = 4

// Place a fixed-position menu at its `{ x, y }` anchor, clamped into the viewport
// by its MEASURED size — callers used to pass a guessed height, which clipped the
// longer variants of a menu and pushed short ones away from the cursor. Bind
// `ref="el"` on the menu element and `:style="pos"`.
export function useMenuPlacement(menu) {
  const el = ref(null)
  const pos = ref({ left: '0px', top: '0px' })
  const at = (left, top) => { pos.value = { left: `${left}px`, top: `${top}px` } }

  watch(menu, async (m) => {
    if (!m) return
    at(m.x, m.y)
    await nextTick()   // laid out, not yet painted
    const r = el.value?.getBoundingClientRect()
    if (!r || menu() !== m) return
    at(Math.max(MARGIN, Math.min(m.x, window.innerWidth - r.width - MARGIN)),
      Math.max(MARGIN, Math.min(m.y, window.innerHeight - r.height - MARGIN)))
  }, { immediate: true })

  return { el, pos }
}
