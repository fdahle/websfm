// The image list's filter (Images ▸ filter field and state): which photos it shows.
// Pure: the list hands in what it knows about each photo (aligned or not, enabled).

// The states a photo can be filtered by, in the order the list offers them.
export const IMAGE_FILTER_STATES = ['all', 'unaligned', 'disabled', 'noKeypoints', 'failed']

export const NO_IMAGE_FILTER = Object.freeze({ text: '', state: 'all' })

/** Whether `filter` leaves any photo out. */
export function imageFilterActive(filter) {
  return !!filter && (filter.text.trim() !== '' || (filter.state ?? 'all') !== 'all')
}

/**
 * Whether photo `img` passes `filter`: its name holds every word typed (any case, any
 * order), and it is in the chosen state. `facts`: { unaligned, enabled } as the list
 * judges them (a photo is unaligned only once a sparse model exists).
 */
export function matchesImageFilter(img, filter, facts = {}) {
  const words = filter.text.toLowerCase().split(/\s+/).filter(Boolean)
  const name = String(img.name ?? '').toLowerCase()
  if (!words.every((w) => name.includes(w))) return false
  switch (filter.state ?? 'all') {
    case 'unaligned':
      return !!facts.unaligned
    case 'disabled':
      return facts.enabled === false
    case 'noKeypoints':
      return img.kpStatus !== 'done'
    case 'failed':
      return !!img.previewFailed
    default:
      return true
  }
}
