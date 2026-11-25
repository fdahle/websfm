// Reference runs kept for reuse: ref/<tool>-<version>/<job id>-<key>/.
//
// COLMAP, Metashape and ODM do not change when WebSfM does, so a scoreboard run takes their
// result from here when nothing that decides it has changed, and reruns only WebSfM. The key
// is everything that decides a reference result:
//   - the tool and its version (ODM: the Docker image's digest),
//   - the config without the keys that only say where or how to watch a run (`out`, `port`…),
//   - the photo set's fingerprint (names and sizes),
//   - the job's arguments and scorers (args, truth, eth3d, checkpoints),
//   - RUNNER_REV, the revision of our runner for that tool.
// Bump a tool's RUNNER_REV whenever a change to its runner (ref/*.mjs, ref/*.py, hist/*_hist.py,
// lib/jobs.mjs) alters what it does for a config it has already run: every stored run of that
// tool then counts as stale and runs again.
//
// A reused job's folder in results/ holds hard links to the stored run's evidence (summary,
// scores, logs) and a record.json naming where it came from, so a table says which numbers
// were measured when.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, copyFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { EVAL, REF, repo } from './paths.mjs'
import { RECORD, datasetFingerprint, toolVersionOf } from './record.mjs'
import { slimKeeps, WORKSPACE_DIR } from './slim.mjs'

/** Our runner's revision per tool: bump on a change in what it does (header). */
export const RUNNER_REV = {
  'colmap': 1,
  'colmap-hist': 2, // 2026-11-24: the film DEM gridded up to 1.2 G cells (4f5324a8)
  'metashape': 1,
  'metashape-hist': 1,
  'metashape-dense': 1,
  'odm': 1,
}

// Config keys that say where a run writes or how it is watched, never what it computes.
const NOT_RESULT = new Set([
  'out',
  'port',
  'profile',
  'name',
  'procTrace',
  'headed',
  'chromeArgs',
  'keepBuild',
  'dev',
  'build',
  'profileReopen',
  'requireGpu',
  'maxOldSpaceMb',
  'unminified',
])

const sortKeys = (v) =>
  Array.isArray(v)
    ? v.map(sortKeys)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, sortKeys(v[k])]),
        )
      : v
const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16)

/** The config's hash without the keys that do not decide a result. */
export function configHash(cfg) {
  const kept = Object.fromEntries(Object.entries(cfg ?? {}).filter(([k]) => !NOT_RESULT.has(k)))
  return sha(JSON.stringify(sortKeys(kept)))
}

const versionCache = new Map()
/** The version of the tool that would run now (ODM: its image's digest). */
export function currentToolVersion(job) {
  const k = `${job.tool} ${(job.args ?? []).includes('--gpu')}`
  if (versionCache.has(k)) return versionCache.get(k)
  let v
  if (job.tool === 'odm') {
    const image = (job.args ?? []).includes('--gpu') ? 'opendronemap/odm:gpu' : 'opendronemap/odm:latest'
    const r = spawnSync('docker', ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image], {
      encoding: 'utf8',
    })
    v = r.status === 0 ? r.stdout.trim().split('@')[1]?.slice(7, 19) : null
  } else v = toolVersionOf(job.tool, null)
  versionCache.set(k, v)
  return v
}

/** Everything that decides a reference job's result, and its hash. */
export function refKey(job, cfg, version = currentToolVersion(job)) {
  const parts = {
    tool: job.tool,
    version,
    runner: RUNNER_REV[job.tool] ?? null,
    config: configHash(cfg),
    dataset: datasetFingerprint(cfg?.images && resolve(repo, cfg.images), cfg)?.sha256 ?? null,
    args: job.args ?? [],
    checkpoints: !!job.checkpoints,
    truth: job.truth ?? null,
    eth3d: job.eth3d ?? null,
  }
  return { parts, hash: sha(JSON.stringify(parts)) }
}

const folderOf = (job, key) =>
  join(REF, `${job.tool}-${key.parts.version ?? 'unknown'}`, `${job.id}-${key.hash.slice(0, 8)}`)

/** The stored run for this job and key, or null. */
export function findStored(job, cfg) {
  if (!(job.tool in RUNNER_REV)) return null
  const key = refKey(job, cfg)
  if (!key.parts.version) return null // cannot tell which version would run: never reuse
  const dir = folderOf(job, key)
  const rec = join(dir, RECORD)
  if (!existsSync(rec)) return null
  const r = JSON.parse(readFileSync(rec, 'utf8'))
  return r.exit === 0 && r.refKey?.hash === key.hash ? { dir, record: r, key } : null
}

/** Hard-link (else copy) a run's evidence from `src` to `dst`: what slimming keeps, but the record. */
export function linkEvidence(src, dst) {
  mkdirSync(dst, { recursive: true })
  for (const e of readdirSync(src)) {
    const p = join(src, e)
    const q = join(dst, e)
    const s = lstatSync(p)
    if (s.isDirectory()) {
      if (!WORKSPACE_DIR.test(e)) linkEvidence(p, q)
    } else if (s.isFile() && e !== RECORD && slimKeeps(e, s.size) && !existsSync(q)) {
      // Never the record: each side writes its own, and a shared inode would let one
      // overwrite the other.
      try {
        linkSync(p, q)
      } catch {
        copyFileSync(p, q)
      }
    }
  }
}

/** Store a finished reference job (its folder `dir`) for reuse. */
export async function store(job, cfg, dir, extra = {}) {
  if (!(job.tool in RUNNER_REV)) return null
  const rec = JSON.parse(readFileSync(join(dir, RECORD), 'utf8'))
  if (rec.exit !== 0) return null
  const key = refKey(job, cfg, extra.version)
  if (!key.parts.version) return null
  const to = folderOf(job, key)
  linkEvidence(dir, to)
  await writeFile(
    join(to, RECORD),
    JSON.stringify({ ...rec, refKey: key, storedFrom: relative(EVAL, dir), ...extra.record }, null, 2) + '\n',
  )
  return to
}

/** Fill a results job folder from a stored run: its evidence, and a record saying so. */
export async function reuse(hit, dir, extraRecord = {}) {
  linkEvidence(hit.dir, dir)
  mkdirSync(dirname(join(dir, RECORD)), { recursive: true })
  const r = { ...hit.record, reusedFrom: relative(EVAL, hit.dir), reusedAt: new Date().toISOString(), ...extraRecord }
  await writeFile(join(dir, RECORD), JSON.stringify(r, null, 2) + '\n')
}
