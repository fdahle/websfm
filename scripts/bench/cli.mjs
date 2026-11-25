// The bench's one way in: every run (an experiment, a scoreboard, the gate) starts here, so
// it lands in the right folder with its record, and `ls` finds it again.
//
//   npm run bench -- exp <topic> ["the question"]   make / reuse exp/<date>-<topic>, print it
//   npm run bench -- run <tool> <config> --exp <topic> [--label <name>] [-- <tool args>]
//   npm run bench -- run --job <scoreboard job id> --exp <topic>   a scoreboard job, as it
//                                                    runs there (args, truth, scorers)
//   npm run bench -- scoreboard [scoreboard.mjs flags]   into results/<date>-<commit>
//   npm run bench -- gate [gate.mjs flags]               into exp/<date>-gate/<commit>
//   npm run bench -- ls [text] [--all]               runs, newest first, from their records
//   npm run bench -- clean [--slim <folder>…] [--yes]  what nothing cites; slim to evidence
//
// Folders: scripts/bench/paths.mjs. The record: record.mjs. Tools: tools.mjs.

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { ARCHIVE, EVAL, EXP, REF, RESULTS, SHARED, expDir, repo, slug } from './paths.mjs'
import { RECORD } from './record.mjs'
import { sizeOf, slim } from './slim.mjs'
import { TOOLS, configPath, runJob } from './tools.mjs'

const argv = process.argv.slice(2)
const verb = argv[0]
const dash = argv.indexOf('--')
const own = dash >= 0 ? argv.slice(1, dash) : argv.slice(1)
const passThrough = dash >= 0 ? argv.slice(dash + 1) : []
const flags = {}
const words = []
for (let i = 0; i < own.length; i++) {
  const a = own[i]
  if (!a.startsWith('--')) words.push(a)
  else if (own[i + 1] === undefined || own[i + 1].startsWith('--')) flags[a.slice(2)] = true
  else flags[a.slice(2)] = own[++i]
}
const list = (d) => (existsSync(d) ? readdirSync(d) : [])
const rel = (p) => relative(EVAL, p) || '.'

// ── exp ──
async function makeExp(topic, question) {
  const dir = expDir(topic, { list: list(EXP), fresh: !!flags.fresh })
  await mkdir(dir, { recursive: true })
  const note = join(dir, 'NOTE.md')
  if (!existsSync(note))
    await writeFile(
      note,
      `# ${slug(topic)}\n\n` +
        `**Question:** ${question ?? '(what this run should answer)'}\n\n` +
        `**Answer:** (fill in when it is known; one line, with the numbers)\n\n` +
        `Runs: one folder each, with its record.json (npm run bench -- ls ${slug(topic)}).\n`,
    )
  return dir
}

// ── run ──
async function runOne() {
  const topic = flags.exp
  if (!topic) throw new Error('run needs --exp <topic>: the experiment it belongs to')
  let job
  if (flags.job) {
    const manifest = JSON.parse(readFileSync(join(repo, 'scripts/bench/scoreboard.json'), 'utf8'))
    for (const t of manifest.tables) for (const j of t.jobs) if (j.id === flags.job) job = { ...j, table: t.id }
    if (!job) throw new Error(`no job ${flags.job} in scoreboard.json`)
    if (passThrough.length) job.args = [...(job.args ?? []), ...passThrough]
  } else {
    const [tool, config] = words
    if (!TOOLS.includes(tool)) throw new Error(`run <tool> <config>: tool is one of ${TOOLS.join(', ')}`)
    if (!config || !existsSync(configPath(config)))
      throw new Error(`no config "${config}" (a name in scripts/bench/configs/, or a path to a .json)`)
    job = { id: `${basename(config, '.json')}-${tool}`, tool, config, args: passThrough }
    for (const k of ['truth', 'eth3d']) if (flags[k]) job[k] = flags[k]
    if (flags.checkpoints) job.checkpoints = true
  }
  const exp = await makeExp(topic)
  const label = slug(flags.label ?? job.id)
  let dir = join(exp, label)
  for (let n = 2; existsSync(dir); n++) dir = join(exp, `${label}~${n}`) // a rerun never overwrites
  console.log(`${job.tool} ${job.config} → ${dir}`)
  const code = await runJob(job, dir, { echo: true, extra: { exp: basename(exp), label: basename(dir) } })
  const r = JSON.parse(readFileSync(join(dir, RECORD), 'utf8'))
  console.log(
    `\n${code === 0 ? 'done' : `FAILED (exit ${code})`} in ${r.seconds} s: ${rel(dir)}` +
      `${r.backend ? ` · backend ${r.backend}` : ''}${r.code?.dirty ? ' · uncommitted changes' : ''}`,
  )
  process.exitCode = code
}

// ── scoreboard / gate: their own scripts, with the folder set here ──
function passOn(script, extra) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [join(repo, 'scripts/bench', script), ...own, ...extra], {
      cwd: repo,
      stdio: 'inherit',
    })
    p.on('close', (c) => done((process.exitCode = c ?? 1)))
  })
}

// ── ls ──
/** Every record under results/, ref/ and exp/, plus folders with none (older runs). */
function collect() {
  const rows = []
  const walk = (dir, depth) => {
    if (existsSync(join(dir, RECORD))) {
      try {
        rows.push({ dir, ...JSON.parse(readFileSync(join(dir, RECORD), 'utf8')) })
      } catch {
        rows.push({ dir, broken: true })
      }
      return
    }
    if (depth === 0) return
    for (const e of list(dir)) {
      const p = join(dir, e)
      if (lstatSync(p).isDirectory() && !/\.(build|files|downloads)$|^profile|^configs$/.test(e)) walk(p, depth - 1)
    }
  }
  for (const area of [RESULTS, REF, EXP]) walk(area, 3)
  return rows
}

function ls() {
  const q = words[0]?.toLowerCase()
  const rows = collect()
    .filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q))
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
  const shown = flags.all ? rows : rows.slice(0, 40)
  const pad = (s, n) => String(s ?? '–').padEnd(n)
  console.log(
    `${pad('started', 17)}${pad('tool', 16)}${pad('config', 26)}${pad('code', 10)}${pad('backend', 15)}${pad('s', 7)}folder`,
  )
  for (const r of shown) {
    const code = r.code ? `${r.code.sha.slice(0, 7)}${r.code.dirty ? '+' : ''}` : '–'
    const tool = r.toolVersion && r.tool !== 'websfm' ? `${r.tool} ${r.toolVersion}` : r.tool
    const ok = r.exit === 0 ? '' : ` ✗ exit ${r.exit}`
    const when = String(r.startedAt ?? '')
      .slice(0, 16)
      .replace('T', ' ')
    const config = r.config?.name ? basename(r.config.name, '.json').slice(0, 25) : null
    console.log(
      `${pad(when, 17)}${pad(tool, 16)}${pad(config, 26)}` +
        `${pad(code, 10)}${pad(r.backend, 15)}${pad(r.seconds, 7)}${rel(r.dir)}${ok}`,
    )
  }
  if (rows.length > shown.length) console.log(`… ${rows.length - shown.length} more (--all)`)
  console.log(`\n+ after a commit: uncommitted changes in src/, crates/ or scripts/ when it ran.`)
  const notes = list(EXP).filter((n) => !q || n.includes(q))
  if (notes.length) {
    console.log(`\nExperiments (exp/), with their question:`)
    for (const n of notes
      .sort()
      .reverse()
      .slice(0, flags.all ? undefined : 20)) {
      const note = join(EXP, n, 'NOTE.md')
      const qn = existsSync(note) ? (readFileSync(note, 'utf8').match(/\*\*Question:\*\* (.*)/)?.[1] ?? '') : ''
      console.log(`  ${pad(n, 40)}${qn}`)
    }
  }
}

// ── clean ──
// The text everything that cites a run is in: the repo's tracked files, the local notes
// (dev/, publication/, gitignored) and the bench configs. A folder whose name is in none
// of them is cited by nothing.
function citingText() {
  const r = spawnSync('git', ['ls-files'], { cwd: repo, encoding: 'utf8' }).stdout ?? ''
  const files = r.split('\n').filter((f) => /\.(md|mjs|js|json|tex|csv|txt|py|ya?ml|sh)$/.test(f))
  const extra = []
  const walk = (d) => {
    for (const e of list(d)) {
      const p = join(d, e)
      const s = statSync(p)
      if (s.isDirectory()) {
        if (!/^(\.git|node_modules|figures)$/.test(e)) walk(p)
      } else if (s.size < 5e6 && /\.(md|mjs|js|json|tex|csv|txt|py|sh)$/.test(e)) extra.push(p)
    }
  }
  for (const d of ['dev', 'publication', 'scripts/bench/configs']) walk(join(repo, d))
  let text = ''
  for (const f of [...files.map((f) => join(repo, f)), ...extra])
    try {
      text += readFileSync(f, 'utf8') + '\n'
    } catch {
      // a file deleted in the tree but still in the index
    }
  return text
}

const gb = (n) => `${(n / 1e9).toFixed(n < 1e9 ? 2 : 1)} GB`

async function clean() {
  const act = !!flags.yes
  if (flags.slim) {
    const targets = [flags.slim, ...words].map((w) => (w.startsWith('/') ? w : join(EVAL, w)))
    let total = 0
    for (const t of targets) {
      if (!existsSync(t)) throw new Error(`no folder ${t}`)
      const f = await slim(t, act)
      total += f
      console.log(`${act ? 'slimmed' : 'would slim'} ${rel(t)}: ${gb(f)}`)
    }
    console.log(`${act ? 'freed' : 'would free'} ${gb(total)}${act ? '' : ' (add --yes)'}`)
    return
  }
  const text = citingText()
  const rows = []
  for (const area of [EXP, ARCHIVE])
    for (const n of list(area)) {
      const p = join(area, n)
      if (!lstatSync(p).isDirectory()) continue
      const cited = text.includes(n)
      const slimmed = existsSync(join(p, 'SLIMMED.txt'))
      rows.push({ p, n, cited, slimmed, size: sizeOf(p) })
    }
  rows.sort((a, b) => b.size - a.size)
  console.log(`${'size'.padStart(9)}  cited  folder`)
  for (const r of rows)
    console.log(
      `${gb(r.size).padStart(9)}  ${r.cited ? 'yes  ' : 'no   '}  ${rel(r.p)}${r.slimmed ? ' (slimmed)' : ''}`,
    )
  const loose = list(EVAL).filter(
    (n) => ![RESULTS, REF, EXP, SHARED, ARCHIVE].map((a) => basename(a)).includes(n) && n !== 'README.txt',
  )
  if (loose.length) console.log(`\nLoose at the top level (move into an area): ${loose.join(', ')}`)
  console.log(
    `\nNot cited: delete, or keep the evidence with  npm run bench -- clean --slim <folder> --yes.` +
      `\nCited folders stay until what cites them is gone (README.txt in ${EVAL}).`,
  )
}

// ── main ──
const help = readFileSync(new URL(import.meta.url), 'utf8')
  .split('\n')
  .slice(0, 14)
  .map((l) => l.replace(/^\/\/ ?/, ''))
  .join('\n')
switch (verb) {
  case 'exp': {
    if (!words[0]) throw new Error('exp <topic> ["the question"]')
    console.log(await makeExp(words[0], words.slice(1).join(' ') || undefined))
    break
  }
  case 'run':
    await runOne()
    break
  case 'scoreboard':
    await passOn('scoreboard.mjs', [])
    break
  case 'gate':
    await passOn('gate.mjs', [])
    break
  case 'ls':
    ls()
    break
  case 'clean':
    await clean()
    break
  default:
    console.log(help)
    if (verb && verb !== 'help') process.exitCode = 2
}
