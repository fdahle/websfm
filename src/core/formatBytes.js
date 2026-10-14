// Bytes → a short human size, the one formatter for the UI and the logs: binary
// units, one decimal below 10 and whole numbers above (512 B, 2.0 KB, 50 MB,
// 1.2 GB). A missing or non-numeric value reads '—'. Dependency-free on purpose,
// so pure core modules can use it too.
export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return '—'
  const n = Math.max(0, Number(bytes))
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024, i = 0
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++ }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}
