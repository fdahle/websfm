import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

// Escape closes the top-most open modal from one hand-kept list (useModalEscape.js
// closeTopModal). A modal added to the store but not to that list does not close on
// Escape, and nothing else would notice: every open-flag must be in the list.
it('every modal the modals store can open closes on Escape', () => {
  const store = readFileSync(new URL('../stores/useModalsStore.js', import.meta.url), 'utf8')
  const escape = readFileSync(new URL('./useModalEscape.js', import.meta.url), 'utf8')
  const flags = [...store.matchAll(/const (\w+Open) = ref\(/g)].map((m) => m[1])
  expect(flags.length).toBeGreaterThan(30)
  const missing = flags.filter((f) => !new RegExp(`\\b${f}\\b`).test(escape))
  expect(missing).toEqual([])
})
