// Basemap reachability from an OpenLayers tile source's load events. Pure: the
// source only needs `on(type, listener)`, so this runs under the node test suite.

/**
 * Watch a basemap source for failing tiles: `onChange(true)` once `threshold`
 * tiles have failed within `windowMs`, `onChange(false)` at the first successful
 * load after a quiet window. Successes in between do not clear it, because
 * offline the cached coarse levels keep loading while the detailed ones fail.
 */
export function watchTileFailures(source, onChange, { threshold = 3, windowMs = 10_000, now = Date.now } = {}) {
  let errors = []
  let failing = false
  const set = (value) => {
    if (value === failing) return
    failing = value
    onChange(value)
  }
  source.on('tileloaderror', () => {
    const t = now()
    errors = errors.filter((e) => t - e < windowMs)
    errors.push(t)
    if (errors.length >= threshold) set(true)
  })
  source.on('tileloadend', () => {
    const t = now()
    errors = errors.filter((e) => t - e < windowMs)
    if (!errors.length) set(false)
  })
}
