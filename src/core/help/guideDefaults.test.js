// The guide's `<!-- param: key  default: … -->` markers against the defaults the app
// runs with. A marker is prose a person wrote, and a default changed in
// `core/defaults.user.js` leaves it behind silently: the hover box would then show the
// old value. Each `<FieldHelp op param>` in a dialog ties a guide section to a setting;
// its `:default-value` (or, for a select, the `*_DEFAULTS` object the dialog's other
// fields of that op use) gives the value the marker must name, as a number, on/off, the option id
// or the option's label in that dialog.
//
// Not covered: markers whose default depends on the project ("Auto: … when …") or on
// no single `*_DEFAULTS` key, and fields without a FieldHelp. Those stay by eye.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { parseGuideDoc } from './guide.js'
import * as DEFAULTS from '../defaults.user.js'

const root = new URL('../../../', import.meta.url)
const read = (p) => readFileSync(new URL(p, root), 'utf8')

const guideDefaults = new Map() // 'op/param' -> marker text
for (const f of readdirSync(new URL('src/guide/', root)).filter((f) => f.endsWith('.md'))) {
  const doc = parseGuideDoc(read(`src/guide/${f}`), f)
  for (const [key, p] of doc.params) if (p.defaultText) guideDefaults.set(`${doc.id}/${key}`, p.defaultText)
}

// `X_DEFAULTS.key`, `X_DEFAULTS.key || 'Auto'`, `` `${X_DEFAULTS.key} px` ``
const DV_RE = /^`?(?:\$\{)?([A-Z0-9_]+_DEFAULTS)\.(\w+)\}?(?: \w+`)?(?:\s*\|\|\s*'([^']*)')?$/

const vueFiles = execFileSync('git', ['ls-files', 'src/**/*.vue'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
const fields = [] // { file, op, param, object?, key?, fallback? }
const objectsOfOp = new Map() // 'file op' -> Set of *_DEFAULTS names that dialog's fields of op read
for (const file of vueFiles) {
  for (const m of read(file).matchAll(/<FieldHelp\b([^>]*)>/g)) {
    const attr = (name) => m[1].match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1]
    const op = attr('op')
    const param = attr('param')
    if (!op || !param) continue
    const dv = attr(':default-value')
    const parsed = dv && DV_RE.exec(dv)
    if (dv && !parsed) continue // a computed default (preset, project data): not checkable here
    if (parsed) {
      fields.push({ file, op, param, object: parsed[1], key: parsed[2], fallback: parsed[3] })
      const k = `${file} ${op}`
      if (!objectsOfOp.has(k)) objectsOfOp.set(k, new Set())
      objectsOfOp.get(k).add(parsed[1])
    } else fields.push({ file, op, param })
  }
}

// The labels a dialog gives option `id`: <option value="id">Label<, { id|value: 'id', label: 'Label' }.
function optionLabels(src, id) {
  const s = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const q = typeof id === 'number' ? `'?${s}'?` : `'${s}'`
  const res = [
    new RegExp(`<option[^>]*\\bvalue="'?${s}'?"[^>]*>([^<]+)<`, 'g'),
    new RegExp(`(?:id|value):\\s*${q}\\s*,[^}]*?label:\\s*'([^']+)'`, 'g'),
    new RegExp(`label:\\s*'([^']+)'[^}]*?(?:id|value):\\s*${q}\\s*[,}]`, 'g'),
  ]
  return res.flatMap((re) => [...src.matchAll(re)].map((m) => m[1].trim()))
}

function names(value, marker, src, fallback) {
  const text = marker.toLowerCase()
  if (typeof value === 'boolean') return value ? /\bon\b/.test(text) : /\boff\b/.test(text)
  if (fallback != null && (value === 0 || value === null || value === '')) {
    return text.includes(fallback.toLowerCase())
  }
  if (typeof value === 'number') {
    const n = text.match(/^-?[\d,]*\.?\d+/)
    if (n && Math.abs(Number(n[0].replace(/,/g, '')) - value) < 1e-9) return true
    if (value === 0 && /\b(auto|off|none)\b/.test(text)) return true
  }
  if (text.includes(String(value).toLowerCase())) return true
  // "Inverse distance" for the option "Inverse distance (smooth)", and the reverse.
  return optionLabels(src, value).some((l) => {
    const label = l.toLowerCase().replace(/…$/, '')
    return text.includes(label) || label.startsWith(text)
  })
}

describe('guide default markers', () => {
  const checked = []
  const wrong = []
  for (const f of fields) {
    const marker = guideDefaults.get(`${f.op}/${f.param}`)
    if (marker == null) continue
    let value
    let fallback = f.fallback
    if (f.object) value = DEFAULTS[f.object]?.[f.key]
    else {
      // A select: the defaults object(s) the same dialog's other fields of this op read
      // must agree on one value for the param. (Not across dialogs: Sentinel-2 and an
      // imported raster share a guide article but not their defaults.)
      const values = [...(objectsOfOp.get(`${f.file} ${f.op}`) ?? [])]
        .map((o) => DEFAULTS[o]?.[f.param])
        .filter((v) => v != null && !Array.isArray(v) && typeof v !== 'object')
      if (new Set(values).size !== 1) continue
      value = values[0]
      fallback = undefined
    }
    if (value === undefined || Array.isArray(value) || (value !== null && typeof value === 'object')) continue
    checked.push(`${f.op}/${f.param}`)
    if (!names(value, marker, read(f.file), fallback)) {
      wrong.push(
        `src/guide/${f.op}.md ▸ ${f.param}: says "${marker}", the app's default is ${JSON.stringify(value)} (${f.file})`,
      )
    }
  }

  it('name the default the app runs with', () => {
    expect(wrong).toEqual([])
  })

  it('are actually checked (the parsing above still finds the fields)', () => {
    // 180 of about 270 markers were checkable when this test was written; a drop far
    // below means a regex above no longer matches the dialogs, not that docs improved.
    expect(new Set(checked).size).toBeGreaterThan(150)
  })
})
