// Saved viewpoints of the 3D view (View ▸ Camera ▸ Views), kept with the project in
// reconstruction.json (`savedViews`, [] when absent). Pure: the viewer reads and sets
// the camera, the reconstruction store keeps the list.
//
// A view is where the camera stood in the 3D scene, which is the model's own frame (a
// refitted georeference leaves it in place). A new main sparse model can put the scene
// elsewhere, so a view keeps the model it was taken in (`model`, a product stamp) and
// is out of date once that model is gone.

const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite)
const NAME_MAX = 60

/** A view's name as it is kept: trimmed, at most 60 characters, or null when empty. */
export function viewName(name) {
  const n = String(name ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, NAME_MAX)
  return n || null
}

/** "View 1", "View 2", … — the first the list does not use. */
export function nextViewName(views, base = 'View') {
  const used = new Set(views.map((v) => v.name))
  for (let n = 1; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`
}

/**
 * A view of `camera` { position, target, up, ortho, halfHeight } named `name`, taken in
 * `model` (the main sparse model's stamp, or null). → the record, or null when the
 * camera is not a valid one.
 */
export function makeView({ id, name, camera, model = null }) {
  const { position, target, up, ortho = false, halfHeight = null } = camera ?? {}
  if (!isVec(position) || !isVec(target) || !isVec(up)) return null
  return {
    id,
    name,
    position: [...position],
    target: [...target],
    up: [...up],
    ortho: !!ortho,
    ...(ortho && Number.isFinite(halfHeight) && halfHeight > 0 ? { halfHeight } : {}),
    model: model ? { id: model.id, createdAt: model.createdAt ?? null } : null,
  }
}

/** The views of a saved document, each checked; anything malformed is left out. */
export function normalizeSavedViews(data) {
  if (!Array.isArray(data)) return []
  return data
    .filter((v) => v && typeof v.id === 'string' && viewName(v.name))
    .map((v) => makeView({ id: v.id, name: viewName(v.name), camera: v, model: v.model }))
    .filter(Boolean)
}

/** Whether `view` was taken in another model than `model` (the main sparse model's stamp). */
export function viewStale(view, model) {
  if (!view?.model) return false
  return !model || view.model.id !== model.id || (view.model.createdAt ?? null) !== (model.createdAt ?? null)
}

/** `views` with `id` named `name`: { views }, or { error: 'empty' | 'taken' | 'missing' }. */
export function renameView(views, id, name) {
  const n = viewName(name)
  if (!n) return { error: 'empty' }
  const view = views.find((v) => v.id === id)
  if (!view) return { error: 'missing' }
  if (views.some((v) => v.id !== id && v.name === n)) return { error: 'taken' }
  return { views: views.map((v) => (v === view ? { ...v, name: n } : v)) }
}
