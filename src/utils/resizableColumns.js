// Vue directive that makes table columns resizable by dragging the right edge
// of each header cell. Attach to a <table> element with v-col-resize.
//
// Widths are written inline onto the <th> cells. On the first drag we freeze
// every column to its current rendered width so dragging one column doesn't
// reflow the others; the last column is left without a handle so the table
// keeps filling its container.

const MIN_WIDTH = 40

function setup(table) {
  const headRow = table.querySelector('thead tr')
  if (!headRow) return
  const ths = Array.from(headRow.children)

  ths.forEach((th, i) => {
    // No handle on the last column — it absorbs the remaining width.
    if (i === ths.length - 1) return
    // Guard against duplicate handles on re-render / HMR.
    if (th.querySelector('.col-resize-handle')) return
    // sticky/relative headers already establish a positioning context for the
    // absolutely-positioned handle; only promote a truly static header.
    if (getComputedStyle(th).position === 'static') th.style.position = 'relative'

    const handle = document.createElement('div')
    handle.className = 'col-resize-handle'
    th.appendChild(handle)

    let startX = 0
    let startW = 0

    function onMove(e) {
      const w = Math.max(MIN_WIDTH, startW + (e.clientX - startX))
      th.style.width = w + 'px'
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    handle.addEventListener('mousedown', (e) => {
      startW = th.getBoundingClientRect().width
      startX = e.clientX
      // Freeze current widths so the other columns hold still while dragging.
      ths.forEach((t) => {
        if (!t.style.width) t.style.width = t.getBoundingClientRect().width + 'px'
      })
      th.style.width = startW + 'px'
      document.addEventListener('mousemove', onMove)
      document.addEventListener('mouseup', onUp)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      e.preventDefault()
      e.stopPropagation()
    })
    // Keep a bare click on the handle from reaching a sortable header.
    handle.addEventListener('click', (e) => e.stopPropagation())
  })
}

export const colResize = {
  mounted(el) {
    // The table may render a frame after the directive mounts (v-if on data).
    requestAnimationFrame(() => setup(el))
  },
  updated(el) {
    requestAnimationFrame(() => setup(el))
  },
}
