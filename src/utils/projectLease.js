// One editable session per project. The browser releases held locks when a tab
// exits/crashes; switching releases the old project only after acquiring the new.
export async function acquireProjectLease(id) {
  if (!globalThis.navigator?.locks?.request) return () => {}
  let release
  const held = new Promise(resolve => { release = resolve })
  return new Promise((resolve, reject) => {
    navigator.locks.request(`websfm:project-session:${id}`, { ifAvailable: true }, async lock => {
      if (!lock) { reject(new Error('This project is already open in another tab. Close it there before opening it here.')); return }
      resolve(release)
      await held
    }).catch(reject)
  })
}
