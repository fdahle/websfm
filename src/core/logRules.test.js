import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { babelParse } from '@vue/compiler-sfc'
import { LOG_SOURCES, LOG_SOURCE_IDS, LOG_LEVEL_IDS, LEGACY_SOURCES, logSourceId, logSourceColor } from './logRules.js'
import { resolveCommand } from './help/commands.js'

// docs/conventions.md ▸ The console: every log line in src/ is read here, as written, and
// held to the rules a person cannot check by eye across 1,400 lines. A line is
// `log(message, level, source, opts)`, `onLog(message, level, source)` or a worker's
// `emit('log', [message, level, source])`.

const FILES = execFileSync('git', ['ls-files', '-co', '--exclude-standard', 'src/*.js', 'src/*.vue'], {
  encoding: 'utf8',
})
  .trim()
  .split('\n')
  .filter((f) => !/\.test\.js$|testutil|^src\/wasm\//.test(f))

const isPure = (file) => /^src\/(core|workers)\//.test(file)

function scriptsOf(file) {
  const full = readFileSync(file, 'utf8')
  if (!file.endsWith('.vue')) return [full]
  return [...full.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1])
}

// Every log call: { file, line, kind, args, code }.
function logCalls(file) {
  const out = []
  for (const code of scriptsOf(file)) {
    const ast = babelParse(code, { sourceType: 'module', plugins: ['topLevelAwait'], errorRecovery: true })
    const visit = (n) => {
      if (!n || typeof n.type !== 'string') return
      if (n.type === 'CallExpression' || n.type === 'OptionalCallExpression') {
        const c = n.callee
        const name =
          c.type === 'Identifier'
            ? c.name
            : /Member/.test(c.type) && c.property.type === 'Identifier'
              ? c.property.name
              : null
        if ((name === 'log' || name === 'onLog') && n.arguments.length >= 1)
          out.push({ file, line: n.loc.start.line, kind: name, args: n.arguments, code })
        const [first, second] = n.arguments
        if (
          name === 'emit' &&
          first?.type === 'StringLiteral' &&
          first.value === 'log' &&
          second?.type === 'ArrayExpression'
        )
          out.push({ file, line: n.loc.start.line, kind: 'emit', args: second.elements, code })
      }
      for (const k in n) {
        if (k === 'loc') continue
        const v = n[k]
        if (Array.isArray(v)) v.forEach(visit)
        else if (v && typeof v === 'object' && v.type) visit(v)
      }
    }
    visit(ast.program)
  }
  return out
}

const CALLS = FILES.flatMap(logCalls)
const where = (c) => `${c.file}:${c.line}`

// The string literals an argument can evaluate to: 'x', a ? 'x' : 'y', s ?? 'x'.
function literalsOf(node) {
  if (!node) return []
  if (node.type === 'StringLiteral') return [node.value]
  if (node.type === 'ConditionalExpression') return [...literalsOf(node.consequent), ...literalsOf(node.alternate)]
  if (node.type === 'LogicalExpression') return [...literalsOf(node.left), ...literalsOf(node.right)]
  return []
}

// The text a message starts with, when it starts with fixed text.
function messageHead(node) {
  if (node?.type === 'StringLiteral') return node.value
  if (node?.type === 'TemplateLiteral') return node.quasis[0].value.cooked
  if (node?.type === 'BinaryExpression') return messageHead(node.left)
  return ''
}

// The fixed text of a message, its placeholders left out: 'a' + `b ${x} c` → 'a b  c'.
function literalText(node) {
  if (!node) return ''
  if (node.type === 'StringLiteral') return node.value
  if (node.type === 'TemplateLiteral') return node.quasis.map((q) => q.value.cooked).join(' ')
  if (node.type === 'BinaryExpression') return `${literalText(node.left)}${literalText(node.right)}`
  if (node.type === 'ConditionalExpression') return `${literalText(node.consequent)} ${literalText(node.alternate)}`
  return ''
}

// The fixed starts a command can have: 'gcp remove', editCommand('gcp remove', …),
// `gcp ${on ? 'enable' : 'disable'}`, a ? x : y.
function commandHeads(node) {
  if (!node) return []
  if (node.type === 'StringLiteral') return [node.value.trim()]
  if (node.type === 'ConditionalExpression') return [...commandHeads(node.consequent), ...commandHeads(node.alternate)]
  if (node.type === 'CallExpression' && node.callee.name === 'editCommand') return commandHeads(node.arguments[0])
  if (node.type === 'TemplateLiteral') {
    let heads = [node.quasis[0].value.cooked]
    for (let i = 0; i < node.expressions.length; i++) {
      const parts = literalsOf(node.expressions[i])
      if (!parts.length) break
      heads = heads.flatMap((h) => parts.map((p) => h + p + node.quasis[i + 1].value.cooked))
    }
    return heads.map((h) => h.trim())
  }
  return []
}

const option = (opts, key) =>
  opts?.type === 'ObjectExpression'
    ? opts.properties.find((p) => p.type === 'ObjectProperty' && (p.key.name ?? p.key.value) === key)
    : undefined

describe('logRules table', () => {
  it('names each source once, with a colour and what it covers', () => {
    expect(new Set(LOG_SOURCE_IDS).size).toBe(LOG_SOURCES.length)
    for (const s of LOG_SOURCES) {
      expect(s.color).toMatch(/^#[0-9a-f]{6}$/)
      expect(s.covers.length).toBeGreaterThan(10)
    }
  })
  it('maps every legacy name onto a source of today', () => {
    for (const [old, now] of Object.entries(LEGACY_SOURCES)) {
      expect(LOG_SOURCE_IDS).toContain(now)
      expect(LOG_SOURCE_IDS).not.toContain(old)
      expect(logSourceId(old)).toBe(now)
      expect(logSourceColor(old)).toBe(logSourceColor(now))
    }
    expect(logSourceColor('Nonsense')).toBe('#888888')
  })
})

describe('log lines (docs/conventions.md ▸ The console)', () => {
  it('are found', () => {
    expect(CALLS.length).toBeGreaterThan(1000)
  })

  it('use a level from core/logRules.js', () => {
    const bad = CALLS.flatMap((c) =>
      literalsOf(c.args[1])
        .filter((l) => !LOG_LEVEL_IDS.includes(l))
        .map((l) => `${where(c)} '${l}'`),
    )
    expect(bad).toEqual([])
  })

  it('use a source from core/logRules.js', () => {
    const bad = CALLS.flatMap((c) =>
      literalsOf(c.args[2])
        .filter((s) => !LOG_SOURCE_IDS.includes(s))
        .map((s) => `${where(c)} '${s}'`),
    )
    expect(bad).toEqual([])
  })

  // Outside core and the workers a line is written where its area is known, so it
  // names its source; a relay of core's lines gives a default (`c ?? 'Dense'`).
  it('name their source outside core and the workers', () => {
    const bad = CALLS.filter((c) => c.kind === 'log' && !isPure(c.file))
      .filter((c) => {
        const src = c.args[2]
        if (!src) return true
        if (src.type === 'Identifier' && /^(c|category|ctx|level)$/.test(src.name)) return true // a relay without a default
        return false
      })
      .filter((c) => !CALLER_TAGS[c.file] && !LOCAL_WRAPPER.test(c.code))
      .map(where)
    expect(bad).toEqual([])
  })

  // The closing line of an operation is written by the code that started it, which
  // knows the result is kept; core and the workers report at info.
  it('never close with success in core or the workers', () => {
    const bad = CALLS.filter((c) => isPure(c.file) && literalsOf(c.args[1]).includes('success')).map(where)
    expect(bad).toEqual([])
  })

  it('write numbers in English, as the rest of the line', () => {
    const bad = CALLS.filter((c) => {
      const node = c.args[0]
      return node && /\.toLocaleString\(\)/.test(c.code.slice(node.start, node.end))
    }).map(where)
    expect(bad).toEqual([])
  })

  it('do not repeat their source at the start of the message', () => {
    const bad = CALLS.flatMap((c) => {
      const head = messageHead(c.args[0]).toLowerCase()
      const sources = c.args[2] ? literalsOf(c.args[2]) : [CALLER_TAGS[c.file]?.source].filter(Boolean)
      return sources.filter((s) => head.startsWith(`${s.toLowerCase()}: `)).map((s) => `${where(c)} "${s}: …"`)
    })
    expect(bad).toEqual([])
  })

  it('start with a capital letter (a file name may lead)', () => {
    const bad = CALLS.filter((c) => {
      const head = messageHead(c.args[0])
      return /^[a-z]/.test(head) && !/^[a-z0-9_.-]+\.(json|txt|csv|las|laz|ply)\b/.test(head)
    }).map((c) => `${where(c)} "${messageHead(c.args[0]).slice(0, 40)}"`)
    expect(bad).toEqual([])
  })

  // One form for a failure: "<what> failed: <why>".
  it('word a failure as "<what> failed: <why>"', () => {
    const bad = CALLS.filter((c) => /\berror: |^error\b|failed — /i.test(literalText(c.args[0]))).map(
      (c) => `${where(c)} "${literalText(c.args[0]).slice(0, 50)}"`,
    )
    expect(bad).toEqual([])
  })

  // The words a user meets by default are theirs (docs/terms.md); shorthand stays in
  // the Detail lines.
  it('use the words of docs/terms.md, and no shorthand outside Detail', () => {
    const shorthand = /\b(BA|kp|obs|OPFS|NCC|ZNCC|NN|init|intrinsics|Pre-BA|REJECTED|ABSOLUTE|Stage [AB])\b/
    const avoid =
      /\b(key point|feature point|interest point|sparse point|bounding box|ROI|depthmap|dense point cloud|orthoimage|check point|geo-reference)/i
    const bad = CALLS.flatMap((c) => {
      const text = literalText(c.args[0])
      const out = []
      if (avoid.test(text)) out.push(`${where(c)}: "${text.match(avoid)[0]}" (docs/terms.md)`)
      if (/\b(WebSFM|Websfm|WEBSFM)\b/.test(text)) out.push(`${where(c)}: write WebSfM`)
      const levels = literalsOf(c.args[1])
      const onlyDebug = levels.length > 0 && levels.every((l) => l === 'debug')
      if (!onlyDebug && shorthand.test(text)) out.push(`${where(c)}: "${text.match(shorthand)[0]}"`)
      return out
    })
    expect(bad).toEqual([])
  })

  // An edit confirmed in the Activity tab can be typed: the line names the command.
  it('in the Activity tab name a console command that resolves', () => {
    const activity = CALLS.filter((c) => {
      const ch = option(c.args[3], 'channel')
      return ch?.value?.type === 'StringLiteral' && ch.value.value === 'activity'
    })
    expect(activity.length).toBeGreaterThan(20)
    const bad = activity.flatMap((c) => {
      const cmd = option(c.args[3], 'command')
      if (!cmd) return [`${where(c)}: no command`]
      const heads = commandHeads(cmd.value)
      if (!heads.length) return [`${where(c)}: the command is not written out (a string or editCommand('…'))`]
      return heads.filter((h) => !resolveCommand(h).cmd).map((h) => `${where(c)}: "${h}" is not a console command`)
    })
    expect(bad).toEqual([])
  })
})

// A file-local helper such as `const log = (m, level) => onLog?.(m, level, 'Project')`
// tags its lines itself; calls to it carry two arguments.
const LOCAL_WRAPPER = /(const|let)\s+log\s*=\s*\([^)]*\)\s*=>\s*\w+\??\.?\([^)]*'[A-Z]/

// Files whose `log` is a wrapper their caller hands in, which tags the lines.
// `source`: the one its caller gives, so the rules that read it still apply.
const CALLER_TAGS = {
  'src/stores/matching/gpuMatchRun.js': {
    source: 'Matching',
    why: 'matchAll.js passes (msg, level) => log(msg, level, "Matching")',
  },
  'src/stores/tuningOverrides.js': {
    source: null,
    why: "applyTuningOverrides's log is its caller's wrapper; the file's own lines name their source",
  },
}
