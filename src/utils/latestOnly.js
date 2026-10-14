// "Only the newest call may write its result" for async refreshes that can overlap
// (a dialog re-reading a report on every edit). Each call takes a token with
// begin(); after every await it asks isCurrent(token) and drops its result — and
// leaves the busy flag to the newer call — when a later begin() has superseded it.
export function createLatest() {
  let current = 0
  return {
    begin: () => ++current,
    isCurrent: (token) => token === current,
  }
}
