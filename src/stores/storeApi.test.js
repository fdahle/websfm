import { it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPinia, setActivePinia } from 'pinia'

// A setup store only exposes what its `return { … }` lists, and a call to a member
// it forgot (`gcpsStore.setGcpEnabled(…)` from the Quality Report, once) is a
// runtime TypeError no other test notices. Read every `const x = useFooStore()` and
// `useFooStore().member` in src/, and check each member used is on the store.
const SRC = fileURLToPath(new URL('..', import.meta.url))

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      if (!['wasm', 'workers'].includes(name)) sources(path, out)
    } else if (/\.(js|vue)$/.test(name) && !/\.test\.js$/.test(name)) out.push(path)
  }
  return out
}

it('every store member used in src/ is one the store returns', async () => {
  setActivePinia(createPinia())
  const stores = new Map()
  for (const name of readdirSync(join(SRC, 'stores')).filter((n) => /^use\w+Store\.js$/.test(n))) {
    const mod = await import(`./${name}`)
    const factory = name.replace(/\.js$/, '')
    if (typeof mod[factory] === 'function') stores.set(factory, mod[factory]())
  }
  const missing = []
  for (const file of sources(SRC)) {
    const text = readFileSync(file, 'utf8')
    const uses = []
    for (const m of text.matchAll(/^([ \t]*).*?(?:const|let)\s+(\w+)\s*=\s*(use\w+Store)\(\)/gm)) {
      const [, indent, v, factory] = m
      // The declaring block: up to the first line indented less than the declaration.
      const rest = text.slice(m.index).split('\n')
      const end = rest.findIndex(
        (line, i) => i > 0 && line.trim() && line.length - line.trimStart().length < indent.length,
      )
      const scope = rest.slice(0, end < 0 ? undefined : end).join('\n')
      for (const [, member] of scope.matchAll(new RegExp(`(?<![\\w.$/'"])${v}\\.(\\w+)`, 'g')))
        uses.push([factory, member])
    }
    for (const [, factory, member] of text.matchAll(/(use\w+Store)\(\)\.(\w+)/g)) uses.push([factory, member])
    for (const [factory, member] of uses) {
      const store = stores.get(factory)
      if (store && !member.startsWith('$') && !(member in store))
        missing.push(`${relative(SRC, file)}: ${factory}().${member}`)
    }
  }
  expect([...new Set(missing)]).toEqual([])
})
