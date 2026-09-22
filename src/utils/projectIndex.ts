export interface ProjectIndexEntry { id: string; [key: string]: unknown }

/** Apply only this session's edits to the latest index, preserving other tabs. */
export function mergeProjectIndex(latest: ProjectIndexEntry[], baseline: ProjectIndexEntry[], snapshot: ProjectIndexEntry[]): ProjectIndexEntry[] {
  const before = new Map(baseline.map(p => [p.id, p]))
  const after = new Map(snapshot.map(p => [p.id, p]))
  const merged = new Map(latest.map(p => [p.id, p]))
  for (const id of before.keys()) if (!after.has(id)) merged.delete(id)
  for (const [id, value] of after) {
    const old = before.get(id)
    if (!old) { merged.set(id, value); continue }
    // A project deleted elsewhere must never be resurrected by a stale tab.
    const current = merged.get(id)
    if (!current) continue
    const updated: ProjectIndexEntry = { ...current }
    for (const key of new Set([...Object.keys(old), ...Object.keys(value)])) {
      if (JSON.stringify(old[key]) !== JSON.stringify(value[key])) {
        if (key in value) updated[key] = value[key]
        else delete updated[key]
      }
    }
    merged.set(id, updated)
  }
  return [...merged.values()]
}
