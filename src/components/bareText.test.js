import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from '@vue/compiler-sfc'
import eslintConfig from '../../eslint.config.js'

// CONTRIBUTING ▸ Text in the UI: a converted file keeps its words in the catalogues.
// ESLint's vue/no-bare-strings-in-template sees text and plain attributes only; this
// looks where it cannot: string literals in template expressions
// ({{ ok ? 'Choose a projected CRS' : '' }}, :hint="`Saved as ${x}`") and in the
// script. A literal reads as words when it has a capitalised word and a space, or three
// words; an id ('local'), a class list ('field-input wide') or a CSS value does not.
// The files are those eslint.config.js lists for the rule.
const FILES = eslintConfig.find((c) => c.rules?.['vue/no-bare-strings-in-template'])?.files ?? []

const INTERPOLATION = 5,
  ELEMENT = 1,
  DIRECTIVE = 7

// The code a template evaluates: {{ … }} and directive expressions.
function templateCode(ast) {
  const out = []
  const walk = (node) => {
    if (node.type === INTERPOLATION) out.push(node.content.content)
    if (node.type === ELEMENT)
      for (const p of node.props) if (p.type === DIRECTIVE && p.exp?.content) out.push(p.exp.content)
    for (const c of node.children ?? []) walk(c)
    for (const b of node.branches ?? []) walk(b)
  }
  if (ast) walk(ast)
  return out
}

const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1')
// A literal is exempt as the argument of a message or log call, or an import.
const EXEMPT_BEFORE = /(\b(t|tx|msg|log|onLog|warn|error|info|debug|import|from)\s*\(?\s*|import\s+)$/

function wordyLiterals(code) {
  const out = []
  const plain = stripComments(code)
  for (const m of plain.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g)) {
    const text = m[2].replace(/\$\{[^}]*\}/g, ' ')
    if (EXEMPT_BEFORE.test(plain.slice(Math.max(0, m.index - 12), m.index))) continue
    const words = text.match(/[A-Za-z]{2,}/g) ?? []
    const capitalised = /\b[A-Z][a-z]+\b/.test(text) && /[a-z]\s+[A-Za-z]/.test(text)
    if (/^(calc|var|rgba?|url)\(/.test(text)) continue
    if (capitalised || (words.length >= 3 && /\s/.test(text.trim()))) out.push(m[0])
  }
  return out
}

describe('converted components', () => {
  it('are listed for the bare-text lint', () => expect(FILES.length).toBeGreaterThan(0))
  it('keep no English in expressions or scripts', () => {
    const found = []
    for (const file of FILES) {
      const src = readFileSync(file, 'utf8')
      const code = file.endsWith('.vue')
        ? (() => {
            const { descriptor } = parse(src, { filename: file })
            return [
              ...templateCode(descriptor.template?.ast),
              descriptor.script?.content ?? '',
              descriptor.scriptSetup?.content ?? '',
            ]
          })()
        : [src]
      for (const c of code) for (const lit of wordyLiterals(c)) found.push(`${file}: ${lit}`)
    }
    expect(found).toEqual([])
  })
})
