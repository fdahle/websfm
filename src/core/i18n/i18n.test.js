import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { IntlMessageFormat } from 'intl-messageformat'
import { CATALOGS, FALLBACK, LANGUAGES, flatten, isMsg, msg, render, renderAll, renderRich } from './index.js'

// A small two-language catalogue, so the rules are checked apart from the real text.
const TEST = {
  en: flatten({
    n: '{n, plural, one {# point} other {# points}}',
    len: '{v, number, ::@##} m',
    kept: 'Kept: {items}.',
    a: 'elevation',
    b: 'brightness',
    nested: 'A grid of {cell}',
    rich: 'Build one first (<strong>Reconstruct ▸ {what}</strong>).',
    onlyEn: 'English only',
  }),
  de: flatten({
    n: '{n, plural, one {# Punkt} other {# Punkte}}',
    len: '{v, number, ::@##} m',
    kept: 'Behalten: {items}.',
    a: 'Höhe',
    b: 'Helligkeit',
    nested: 'Ein Raster von {cell}',
  }),
}

describe('render', () => {
  it('picks the plural form and formats numbers in the language', () => {
    expect(render(msg('n', { n: 1 }), 'en', TEST)).toBe('1 point')
    expect(render(msg('n', { n: 1204 }), 'en', TEST)).toBe('1,204 points')
    expect(render(msg('n', { n: 1204 }), 'de', TEST)).toBe('1.204 Punkte')
    expect(render(msg('len', { v: 0.051234 }), 'de', TEST)).toBe('0,0512 m')
    expect(render(msg('len', { v: 1234.5 }), 'en', TEST)).toBe('1,230 m')
  })
  it('renders messages inside messages, and lists with the language’s "and"', () => {
    const items = [msg('a'), msg('b')]
    expect(render(msg('kept', { items }), 'en', TEST)).toBe('Kept: elevation and brightness.')
    expect(render(msg('kept', { items }), 'de', TEST)).toBe('Behalten: Höhe und Helligkeit.')
    expect(render(msg('nested', { cell: msg('len', { v: 2.5 }) }), 'de', TEST)).toBe('Ein Raster von 2,5 m')
  })
  it('falls back to English for a key a language lacks, and shows an unknown key', () => {
    expect(render(msg('onlyEn'), 'de', TEST)).toBe('English only')
    expect(render(msg('no.such.key'), 'de', TEST)).toBe('no.such.key')
    expect(render(msg('n', { n: 2 }), 'fr', TEST)).toBe('2 points')
  })
  it('passes plain strings through, and keeps or drops inline tags', () => {
    expect(render('as is')).toBe('as is')
    expect(render(null)).toBe('')
    const m = msg('rich', { what: 'Dense Model' })
    expect(render(m, 'en', TEST)).toBe('Build one first (Reconstruct ▸ Dense Model).')
    expect(renderRich(m, 'en', TEST)).toEqual([
      'Build one first (',
      { tag: 'strong', children: ['Reconstruct ▸ Dense Model'] },
      ').',
    ])
  })
  it('renders an object of effects, { short, long } pairs included', () => {
    const out = renderAll({ a: msg('a'), pair: { short: msg('b'), long: msg('n', { n: 1 }) }, s: 'x' }, 'de', TEST)
    expect(out).toEqual({ a: 'Höhe', pair: { short: 'Helligkeit', long: '1 Punkt' }, s: 'x' })
  })
  it('makes messages that survive structured cloning (a worker posts them)', () => {
    const m = msg('kept', { items: [msg('a'), msg('b')] })
    const copy = structuredClone(m)
    expect(isMsg(copy)).toBe(true)
    expect(render(copy, 'en', TEST)).toBe('Kept: elevation and brightness.')
  })
})

// The argument names of an ICU message, nested plural/select branches included.
function argNames(source) {
  const names = new Set()
  const walk = (els) => {
    for (const el of els) {
      if (el.value && typeof el.value === 'string' && el.type !== 0) names.add(el.value)
      for (const opt of Object.values(el.options ?? {})) walk(opt.value)
      if (el.children) walk(el.children)
    }
  }
  walk(new IntlMessageFormat(source, 'en').getAst())
  return [...names].sort()
}

describe('catalogues', () => {
  const en = CATALOGS[FALLBACK]

  it('list every language they hold, and parse', () => {
    expect(LANGUAGES.map((l) => l.id).sort()).toEqual(Object.keys(CATALOGS).sort())
    for (const [lang, cat] of Object.entries(CATALOGS))
      for (const [key, source] of Object.entries(cat))
        expect(() => new IntlMessageFormat(source, lang), `${lang} ${key}`).not.toThrow()
  })

  it('hold, in every other language, only English keys, with the same arguments', () => {
    for (const [lang, cat] of Object.entries(CATALOGS)) {
      if (lang === FALLBACK) continue
      for (const [key, source] of Object.entries(cat)) {
        expect(en[key], `${lang} ${key}: no such English key`).toBeDefined()
        expect(argNames(source), `${lang} ${key}`).toEqual(argNames(en[key]))
      }
    }
  })

  // A menu path in a message ("Reconstruct ▸ Dense Model") names the ribbon as that
  // language words it: on each side of every ▸ stands a tab, group, section or command
  // label of the same language. A renamed button fails here, not in a user's hands.
  it('name menu paths as the ribbon words them, in each language', () => {
    const bad = []
    for (const lang of Object.keys(CATALOGS)) {
      const text = (key) => render(msg(key), lang).replace(/-\n/g, '').replace(/\n/g, ' ').replace(/…$/, '')
      const names = Object.keys(en)
        .filter((k) => /^ribbon\.(tab|group|section)\.|^ribbon\.cmd\..*\.label$/.test(k))
        .map(text)
        .sort((a, b) => b.length - a.length)
      for (const [key, source] of Object.entries(CATALOGS[lang])) {
        if (key.startsWith('ribbon.cmd.') && !key.endsWith('.tip')) continue
        const plain = source.replace(/<\/?\w+>/g, '')
        let at = plain.indexOf('▸')
        while (at >= 0) {
          const before = plain.slice(0, at).replace(/\s*▾?\s*$/, '')
          const after = plain.slice(at + 1).trimStart()
          if (!names.some((n) => before.endsWith(n)) || !names.some((n) => after.startsWith(n)))
            bad.push(`${lang} ${key}: …${plain.slice(Math.max(0, at - 25), at + 30)}…`)
          at = plain.indexOf('▸', at + 1)
        }
      }
    }
    expect(bad).toEqual([])
  })

  // Every key the code names exists in English: t('a.b'), msg('a.b'), <I18nText k="a.b">.
  // A key built in a template literal (`a.${x}`) needs some key under its fixed prefix.
  it('have every key the code names', () => {
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src/**/*.js', 'src/**/*.vue'], {
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter((f) => !f.endsWith('.test.js') && !f.startsWith('src/wasm/'))
    const keys = Object.keys(en)
    const missing = []
    for (const file of files) {
      // Comment lines name keys as examples.
      const src = readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n')
      for (const m of src.matchAll(/\b(?:t|msg)\(\s*(['"`])([A-Za-z][\w.]*)(\$\{)?/g)) {
        const [, quote, key, dynamic] = m
        const ok = quote === '`' && dynamic ? keys.some((k) => k.startsWith(key)) : key in en
        if (!ok && (key.includes('.') || key in en || dynamic)) missing.push(`${file}: ${key}${dynamic ? '…' : ''}`)
      }
      for (const m of src.matchAll(/<I18nText\b[^>]*\sk="([^"]+)"/g))
        if (!(m[1] in en)) missing.push(`${file}: ${m[1]}`)
    }
    expect(missing).toEqual([])
  })
})
