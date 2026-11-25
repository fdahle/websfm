// record.json: the conditions one run ran under, written beside its results by every
// runner the CLI and the scoreboard start. Two numbers compare only when their records
// agree on what should not differ (the config, the photos, the machine, the backend);
// `bench ls` shows them, and nobody has to remember them.
//
// Nothing here names the machine or the user: a scoreboard pack (and its records) is a
// release asset.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { cpus, homedir, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { COLMAP, PYTHON, repo } from './paths.mjs'

export const RECORD = 'record.json'

const sh = (cmd, argv, cwd = repo) => {
  const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8' })
  return r.status === 0 ? r.stdout.trim() : null
}

/** The code that ran: commit, branch, and whether src/, crates/ or scripts/ had changes. */
export function gitState() {
  const sha = sh('git', ['rev-parse', 'HEAD'])
  if (!sha) return null
  const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no', '--', 'src', 'crates', 'scripts'])
  return { sha, branch: sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']), dirty: !!dirty }
}

let machineCache = null
/** CPU, memory and GPU: what decides a timing. */
export function machine() {
  if (machineCache) return machineCache
  const gpu = sh('nvidia-smi', ['--query-gpu=name,driver_version', '--format=csv,noheader'])
  const [gpuName, driver] = (gpu?.split('\n')[0] ?? '').split(',').map((s) => s.trim())
  machineCache = {
    cpu: cpus()[0]?.model.replace(/\s+/g, ' ').trim() ?? null,
    threads: cpus().length,
    memGB: Math.round(totalmem() / 2 ** 30),
    gpu: gpuName || null,
    driver: driver || null,
  }
  return machineCache
}

/**
 * The photos a run read, as a fingerprint of their names and sizes (not their bytes: a
 * 30 GB set would take minutes). Same fingerprint, same set.
 * @param {string | undefined} dir
 * @param {{ include?: string, limit?: number }} [cfg]
 */
export function datasetFingerprint(dir, cfg = {}) {
  if (!dir || !existsSync(dir)) return null
  const re = cfg.include ? new RegExp(cfg.include) : null
  let files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => (e.isFile() || e.isSymbolicLink()) && (!re || re.test(e.name)))
    .map((e) => e.name)
    .sort()
  if (cfg.limit > 0) files = files.slice(0, cfg.limit)
  const h = createHash('sha256')
  let bytes = 0
  for (const f of files) {
    const size = statSync(join(dir, f)).size
    bytes += size
    h.update(`${f}\t${size}\n`)
  }
  return { dir, files: files.length, bytes, sha256: h.digest('hex').slice(0, 16) }
}

/** A file's sha256 (first 16 hex digits), or null when it is not there. */
export function fileHash(path) {
  if (!path || !existsSync(path)) return null
  return createHash('sha256').update(readFileSync(path)).digest('hex').slice(0, 16)
}

/**
 * The WebGPU backend a WebSfM run used, from its log: the adapter it named, or
 * "SwiftShader" (the software fallback: timings from it mean nothing), or "CPU".
 * @param {string} log the run's .log text
 */
export function backendOf(log) {
  const m = [...log.matchAll(/backend = WebGPU \(([^)]*)\)/g)].map((x) => x[1])
  if (!m.length) return /WebGPU (?:unavailable|not available)|CPU path/i.test(log) ? 'CPU' : null
  if (m.some((x) => /swiftshader/i.test(x))) return 'SwiftShader'
  return m[0]
}

const asked = new Map()
const askOnce = (key, f) => (asked.has(key) ? asked.get(key) : (asked.set(key, f()), asked.get(key)))

/**
 * The version of the tool that ran: from its summary where the runner writes it, else
 * from the tool itself (the film runners write none).
 */
export function toolVersionOf(tool, summary) {
  if (tool === 'websfm') return (summary?.commit?.sha ?? gitState()?.sha)?.slice(0, 7) ?? null
  if (tool === 'odm') return summary?.odm?.version ?? null
  if (tool.startsWith('metashape')) {
    const v = summary?.metashape
    if (typeof v === 'string') return v
    if (v?.version) return v.version
    return askOnce('metashape', () => sh(PYTHON, ['-c', 'import Metashape; print(Metashape.app.version)']))
  }
  if (tool.startsWith('colmap')) {
    const exe = summary?.colmap?.exe ?? COLMAP
    return askOnce(`colmap ${exe}`, () => sh(exe, ['-h'])?.match(/COLMAP ([\d.]+)/)?.[1] ?? null)
  }
  return null
}

// Paths as a reader elsewhere can take them: the repo as <repo>, the home folder as ~.
const portable = (s) => (s == null ? s : String(s).split(repo).join('<repo>').split(homedir()).join('~'))

/**
 * Write <dir>/record.json.
 * @param {string} dir the job's folder
 * @param {object} r
 * @param {string} r.tool
 * @param {string} [r.config] config name; `configPath` its file
 * @param {string} [r.configPath]
 * @param {object} [r.cfg] the parsed config (for the photo folder)
 * @param {string} [r.summary] the tool's summary file
 * @param {string} [r.log] the run's log (WebSfM: for the backend)
 * @param {string} r.startedAt
 * @param {number} r.exit
 * @param {string[][]} r.steps the command lines run
 * @param {object} [r.extra] anything else to keep (job id, table, topic)
 */
export async function writeRecord(dir, r) {
  const summary = r.summary && existsSync(r.summary) ? JSON.parse(readFileSync(r.summary, 'utf8')) : null
  const log = r.log && existsSync(r.log) ? readFileSync(r.log, 'utf8') : ''
  const finishedAt = new Date().toISOString()
  const dataset = datasetFingerprint(r.cfg?.images && resolve(repo, r.cfg.images), r.cfg)
  if (dataset) dataset.dir = portable(dataset.dir)
  const record = {
    schema: 1,
    tool: r.tool,
    toolVersion: toolVersionOf(r.tool, summary),
    config: r.config ? { name: r.config, sha256: fileHash(r.configPath) } : null,
    dataset,
    code: gitState(),
    machine: machine(),
    backend: r.tool === 'websfm' ? backendOf(log) : null,
    startedAt: r.startedAt,
    finishedAt,
    seconds: Math.round((Date.parse(finishedAt) - Date.parse(r.startedAt)) / 1000),
    exit: r.exit,
    steps: r.steps.map((s) => portable(s.join(' '))),
    ...(r.extra ?? {}),
  }
  await writeFile(join(dir, RECORD), JSON.stringify(record, null, 2) + '\n')
  return record
}
