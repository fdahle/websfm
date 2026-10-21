// What the project-load overlay shows, from the phases still running.
//
// Images and the project stores restore concurrently (useProjectLifecycle). The
// image count is the most concrete thing to show while it runs; once it is done
// the overlay names the slowest remaining step instead of falling silent — that
// silence, after the last image, read as a hang.
//
// `images`: { done, total, label } while images load, else null.
// `stores`: Map storeId → { label, done, total } | null (null = finished).
// Returns { label, done, total, detail } or null when nothing is pending.

const STORE_NAMES = {
  reconstruction: 'Reconstruction',
  matches: 'Matches',
  external: 'Reference data',
  gcps: 'Ground control',
  scaleBars: 'Scale bars',
  footprints: 'Footprints',
  poses: 'Camera poses',
  measurements: 'Measurements',
  workflows: 'Workflows',
  log: 'Log',
}

export const storeDisplayName = (id) => STORE_NAMES[id] ?? id

export function loadProgressView(images, stores) {
  const pending = [...(stores ?? [])].filter(([, s]) => s)
  const others = (exclude) => pending.filter(([id]) => id !== exclude).map(([id]) => storeDisplayName(id))
  if (images) {
    return {
      label: `Loading images${images.label ? ` — ${images.label}` : ''}`,
      done: images.done ?? 0,
      total: images.total ?? 0,
      detail: null,
    }
  }
  if (!pending.length) return null
  // The store that said what it is doing; a counted step first, since it moves.
  const active = pending.find(([, s]) => s.label && s.total > 0) ?? pending.find(([, s]) => s.label)
  if (!active) {
    return { label: `Restoring ${others(null).join(', ')}…`, done: 0, total: 0, detail: null }
  }
  const [id, s] = active
  const rest = others(id)
  return {
    label: `${storeDisplayName(id)}: ${s.label}`,
    done: s.done ?? 0,
    total: s.total ?? 0,
    detail: rest.length ? `Also restoring: ${rest.join(', ')}` : null,
  }
}
