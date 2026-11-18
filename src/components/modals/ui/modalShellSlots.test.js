import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { parse } from '@vue/compiler-sfc'

// docs/conventions.md ▸ Every dialog's frame: a dialog's title is ModalShell's own, so
// every dialog looks alike. The shell's slots are #badge, #actions, #tabs, #footer and
// the body; one it does not have (a #header that once replaced the title) would be
// dropped without a word, so this fails on it.
const ROOT = new URL('../..', import.meta.url).pathname
const SLOTS = new Set(['badge', 'actions', 'tabs', 'footer', 'default'])

function vueFiles(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) vueFiles(p, out)
    else if (e.name.endsWith('.vue')) out.push(p)
  }
  return out
}

describe('ModalShell slots', () => {
  it('every dialog fills only the slots the shell has', () => {
    const wrong = []
    // ModalShell elements anywhere in a template, and the slot each direct <template #x> fills.
    const visit = (node, file) => {
      if (node.tag === 'ModalShell') {
        for (const child of node.children ?? []) {
          if (child.tag !== 'template') continue
          const slot = child.props?.find((p) => p.type === 7 && p.name === 'slot')
          const name = slot?.arg?.content ?? 'default'
          if (!SLOTS.has(name)) wrong.push(`${relative(ROOT, file)}: #${name}`)
        }
      }
      for (const child of node.children ?? []) visit(child, file)
    }
    for (const file of vueFiles(ROOT)) {
      const src = readFileSync(file, 'utf8')
      if (!src.includes('<ModalShell')) continue
      const ast = parse(src).descriptor.template?.ast
      if (ast) visit(ast, file)
    }
    expect(wrong).toEqual([])
  })
})
