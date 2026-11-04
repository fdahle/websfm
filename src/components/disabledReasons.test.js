import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@vue/compiler-sfc'

// CONTRIBUTING ▸ Disabled controls say why: a control that can be disabled carries a
// title (its hover tooltip) saying why, in the user's terms. Disabled elements swallow
// mouse events in some browsers, so the title sits on the disabled element itself.
// This walks every component template and lists any element with a `disabled`
// attribute or binding but no `title` / `:title`.
const ROOT = new URL('.', import.meta.url).pathname

// Genuine exceptions, as 'path/from/components.vue:line' — none so far.
const ALLOWED = new Set([])

function vueFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) vueFiles(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

const ELEMENT = 1,
  ATTRIBUTE = 6,
  DIRECTIVE = 7

// The prop name a node attribute or `v-bind:x` / `:x` directive sets, else null.
function propName(p) {
  if (p.type === ATTRIBUTE) return p.name
  if (p.type === DIRECTIVE && p.name === 'bind' && p.arg?.type === 4 && p.arg.isStatic) return p.arg.content
  return null
}

// `v-bind="{ …, title: … }"` counts as a title when the object literal names one.
function spreadsTitle(p) {
  return p.type === DIRECTIVE && p.name === 'bind' && !p.arg && /\btitle\b/.test(p.exp?.content ?? '')
}

function missingIn(file) {
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
  const ast = descriptor.template?.ast
  const out = []
  const walk = (node) => {
    if (node.type === ELEMENT) {
      const names = node.props.map(propName)
      if (names.includes('disabled') && !names.includes('title') && !node.props.some(spreadsTitle))
        out.push(`${file.slice(ROOT.length)}:${node.loc.start.line} <${node.tag}>`)
    }
    for (const c of node.children ?? []) walk(c)
    // v-if / v-for branches hang their children off `branches`.
    for (const b of node.branches ?? []) walk(b)
  }
  if (ast) walk(ast)
  return out
}

describe('disabled controls', () => {
  it('say why they are disabled (a title on every disabled element)', () => {
    const missing = vueFiles(ROOT)
      .flatMap(missingIn)
      .filter((m) => !ALLOWED.has(m.replace(/ <.*$/, '')))
    expect(missing).toEqual([])
  })
})
