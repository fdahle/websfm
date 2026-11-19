// Stepping through the photos in the image list's order (Picture ▸ Previous / Next and
// their keys). Pure: the list hands its order in (composables/useImageOrder.js).

/**
 * The photo `step` places from `currentId` in `order` (an array of image ids), or null
 * past either end (the list does not wrap) or when `currentId` is not in it.
 */
export function stepImage(order, currentId, step) {
  const i = order.findIndex((id) => String(id) === String(currentId))
  if (i < 0) return null
  return order[i + step] ?? null
}

/** Where `currentId` stands: { first, last } (both false when it is not in `order`). */
export function imagePlace(order, currentId) {
  const i = order.findIndex((id) => String(id) === String(currentId))
  return { first: i === 0, last: i >= 0 && i === order.length - 1 }
}
