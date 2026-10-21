import { ref, computed, watch, onBeforeUnmount, nextTick, unref } from 'vue'
import { computeWindow, prefixOffsets, scrollToReveal } from '../utils/virtualWindow.js'

// Virtual scrolling for long fixed-row lists and tables (TODO ▸ SC-8): only the rows
// that intersect the scroll viewport (plus `overscan`) are in the DOM; two spacer
// elements of height `padTop` / `padBottom` stand in for the rest. The window maths
// is pure (utils/virtualWindow.js); this composable only measures the DOM.
//
// It works with any scroll container, not just its own: the list element (`listRef`,
// bound in the template to the <ul>/<tbody> whose top is row 0's top) can sit
// anywhere inside a scrolling ancestor — the sidebar, a Quality Report section, a
// modal body — and the window is derived from where that element sits in it.
//
// At or below `threshold` rows it is OFF: every row renders and the spacers are 0,
// so a small list keeps exactly the DOM (and behaviour) it had before.
//
// Options:
//   items        () => any[]               the full row list (reactive getter)
//   itemHeight   number | Ref<number>      fixed row height in px
//   heightOf     (item, index) => number   per-row heights (variable rows); overrides itemHeight
//   threshold    number = 120              virtualise only above this many rows
//   overscan     number = 8                extra rows rendered above and below
//   scroller     () => Element | null      explicit scroll container (default: the
//                                          nearest ancestor of listRef that scrolls)
//   measure      boolean = false           fixed mode: adopt the rendered height of the
//                                          first `[data-vrow]` element (table rows whose
//                                          height comes from CSS padding + content)
// Returns { listRef, enabled, start, visibleItems, padTop, padBottom, scrollToIndex, refresh }.
// Render `visibleItems` (absolute index = start + i) between two spacers.
export function useVirtualList({
  items,
  itemHeight = 24,
  heightOf = null,
  threshold = 120,
  overscan = 8,
  scroller = null,
  measure = false,
} = {}) {
  const listRef = ref(null)
  const scrollTop = ref(0) // list space: px from the top of row 0
  const viewport = ref(0)
  const measured = ref(0)

  const rows = computed(() => items() ?? [])
  const enabled = computed(() => rows.value.length > threshold)
  const rowHeight = computed(() => measured.value || unref(itemHeight) || 24)
  const offsets = computed(() => {
    if (!heightOf || !enabled.value) return null
    const list = rows.value
    const h = new Array(list.length)
    for (let i = 0; i < list.length; i++) h[i] = heightOf(list[i], i)
    return prefixOffsets(h)
  })

  const win = computed(() => {
    const n = rows.value.length
    if (!enabled.value) return { start: 0, end: n, padTop: 0, padBottom: 0 }
    return computeWindow({
      count: n,
      itemHeight: rowHeight.value,
      offsets: offsets.value,
      scrollTop: scrollTop.value,
      viewportHeight: viewport.value,
      overscan,
    })
  })
  const start = computed(() => win.value.start)
  const visibleItems = computed(() => {
    const { start: s, end } = win.value
    const list = rows.value
    return s === 0 && end === list.length ? list : list.slice(s, end)
  })
  const padTop = computed(() => win.value.padTop)
  const padBottom = computed(() => win.value.padBottom)

  // ── DOM side ──
  let el = null // the scroll container
  let ro = null
  let raf = 0

  function isScrollable(node) {
    const oy = getComputedStyle(node).overflowY
    return oy === 'auto' || oy === 'scroll' || oy === 'overlay'
  }
  // The nearest ancestor that actually scrolls vertically. An `overflow-x: auto`
  // wrapper also computes `overflow-y: auto` but grows with its content, so prefer an
  // ancestor whose content overflows it; fall back to the first scrollable one.
  function findScroller(node) {
    let fallback = null
    for (let p = node?.parentElement; p; p = p.parentElement) {
      if (!isScrollable(p)) continue
      if (p.scrollHeight > p.clientHeight + 1) return p
      fallback ??= p
    }
    return fallback ?? document.scrollingElement ?? document.documentElement
  }

  // The document scroller's own box moves with its scroll (and it reports scroll
  // events on window), so it is measured against the viewport instead.
  const isDocument = (node) => node === document.scrollingElement || node === document.documentElement
  function listOffset() {
    const list = listRef.value
    if (!list || !el) return 0
    const top = isDocument(el) ? 0 : el.getBoundingClientRect().top
    return list.getBoundingClientRect().top - top + el.scrollTop
  }

  function update() {
    raf = 0
    if (!el || !listRef.value) return
    viewport.value = isDocument(el) ? window.innerHeight : el.clientHeight
    scrollTop.value = el.scrollTop - listOffset()
  }
  function schedule() {
    if (!raf) raf = requestAnimationFrame(update)
  }

  let scrollTarget = null
  function detach() {
    scrollTarget?.removeEventListener('scroll', schedule)
    scrollTarget = null
    ro?.disconnect()
    ro = null
    el = null
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
  }
  function attach() {
    detach()
    if (!enabled.value || !listRef.value) return
    el = (scroller ? scroller() : null) ?? findScroller(listRef.value)
    if (!el) return
    scrollTarget = isDocument(el) ? window : el
    scrollTarget.addEventListener('scroll', schedule, { passive: true })
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule)
      ro.observe(el)
      ro.observe(listRef.value)
    }
    update()
  }

  // Fixed-height tables: the real row height comes from CSS (padding, a thumbnail,
  // borders); adopt it once rendered so the spacers stay exact.
  function remeasure() {
    if (!measure || heightOf || !enabled.value || !listRef.value) return
    const row = listRef.value.querySelector('[data-vrow]')
    const h = row?.getBoundingClientRect().height ?? 0
    if (h > 0 && Math.abs(h - rowHeight.value) > 0.5) measured.value = h
  }

  watch(
    [listRef, enabled],
    () => {
      attach()
      nextTick(remeasure)
    },
    { flush: 'post' },
  )
  watch(win, () => nextTick(remeasure), { flush: 'post' })
  onBeforeUnmount(detach)

  // Bring row `index` into view (keyboard, a rename on a row that may be off-screen).
  function scrollToIndex(index) {
    if (!enabled.value || !el) return
    const target = scrollToReveal({
      index,
      count: rows.value.length,
      itemHeight: rowHeight.value,
      offsets: offsets.value,
      scrollTop: el.scrollTop - listOffset(),
      viewportHeight: isDocument(el) ? window.innerHeight : el.clientHeight,
    })
    if (target == null) return
    el.scrollTop = target + listOffset()
    update()
  }

  return { listRef, enabled, start, visibleItems, padTop, padBottom, scrollToIndex, refresh: schedule }
}
