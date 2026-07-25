// Duration formatting for the progress modal.
//
// Two functions because they describe two different kinds of number, and conflating
// them is what made the old ETA read as more trustworthy than it is:
//   • elapsed is MEASURED — exact, so it shows seconds (which double as the "still
//     alive" signal on a long run),
//   • remaining is ESTIMATED — a blended EMA over a workload whose per-item cost
//     varies by an order of magnitude, so second-level precision is a false claim.
//     It rounds coarser the further out it looks, which also means the number stops
//     changing every tick.

// Exact clock for elapsed time. Under an hour: M:SS. From an hour up: "Xh Ym" — a long
// run otherwise renders as e.g. "9000:00", unbounded minutes that read as anything but
// 150 hours.
export function formatClock(secs) {
  const s = Math.max(0, Math.round(secs))
  if (s >= 3600) {
    // Floor the minutes so a value like 7170 s can't round up to "1h 60m".
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m > 0 ? `${h}h ${m}m` : `${h}h`
  }
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

// Coarse, honest remaining time. Precision degrades with distance — the estimate's
// error grows the same way, and a stable number is read as more trustworthy than a
// precise one that twitches.
//
//   < 1 min   → "less than a minute"   (no point counting down the last few seconds)
//   < 10 min  → nearest minute         "4 minutes"
//   < 1 hour  → nearest 5 minutes      "25 minutes"
//   ≥ 1 hour  → nearest 10 minutes     "2h 20m"
export function formatRemaining(secs) {
  const s = Math.max(0, secs)
  if (s < 60) return 'less than a minute'

  const roundTo = (mins, step) => Math.round(mins / step) * step
  const mins = s / 60

  if (s < 600) {
    const m = Math.max(1, Math.round(mins))
    return `${m} minute${m === 1 ? '' : 's'}`
  }
  if (s < 3600) {
    // Rounding 3599 s up to 60 would render "60 minutes" rather than an hour.
    const m = roundTo(mins, 5)
    if (m < 60) return `${m} minutes`
    return '1h'
  }
  const totalM = roundTo(mins, 10)
  const h = Math.floor(totalM / 60)
  const m = totalM % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}
