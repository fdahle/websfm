// Where bench runs live, in one place. Every runner (run-bench, the reference tools, the
// scoreboard, the gate) takes its default output folder from here, so a run never lands
// somewhere nobody will look.
//
// The eval root, from the first that is set:
//   $WEBSFM_EVAL, then "eval" in scripts/bench/paths.local.json (gitignored), else
//   <repo>/bench-out (a machine without a bench disk: everything stays in the repo).
// The data root ($WEBSFM_DATA, "data" in paths.local.json) is where the photo sets are.
//
// Under the eval root:
//   results/<name>/          scoreboard runs: the only runs docs and the paper cite
//   ref/<tool>-<version>/    COLMAP, Metashape and ODM runs kept for reuse
//   exp/<date>-<topic>/      everything else, each with a NOTE.md (question, answer)
//   shared/                  inputs, masks, tools, caches several runs read
//   archive/                 runs from before this layout, slimmed to their evidence
// Nothing else sits at the top level. `checkOut` lets a run write only into results/, ref/ and exp/.

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const localFile = join(repo, 'scripts/bench/paths.local.json')
const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {}

export const EVAL = resolve(process.env.WEBSFM_EVAL ?? local.eval ?? join(repo, 'bench-out'))
export const DATA = process.env.WEBSFM_DATA ?? local.data ?? null
// The Python with Metashape's module ($METASHAPE_PYTHON, "python" in paths.local.json).
export const PYTHON =
  process.env.METASHAPE_PYTHON ?? local.python ?? join(homedir(), 'miniconda3/envs/hist_env3/bin/python')
// COLMAP's binary ($COLMAP, "colmap" in paths.local.json, else `colmap` on PATH).
export const COLMAP = process.env.COLMAP ?? local.colmap ?? 'colmap'

export const RESULTS = join(EVAL, 'results')
export const REF = join(EVAL, 'ref')
export const EXP = join(EVAL, 'exp')
export const SHARED = join(EVAL, 'shared')
export const ARCHIVE = join(EVAL, 'archive')
// Where a run may write: never into archive/ (frozen) or shared/ (inputs).
const RUN_AREAS = [RESULTS, REF, EXP]

export const today = () => new Date().toISOString().slice(0, 10)

/** A topic as a folder name: lower case, words joined by '-'. */
export function slug(topic) {
  const s = String(topic)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!s) throw new Error(`"${topic}" is not a topic name`)
  return s
}

/**
 * An experiment's folder, `exp/<date>-<topic>`. The newest folder of that topic is reused
 * (a topic continued the next day stays in one place); `fresh` starts a new one today.
 * @param {string} topic
 * @param {{ fresh?: boolean, list?: string[] }} [opts] `list`: the names in exp/ (tests)
 */
export function expDir(topic, opts = {}) {
  const t = slug(topic)
  const names = opts.list ?? []
  const same = names.filter((n) => /^\d{4}-\d{2}-\d{2}-/.test(n) && n.slice(11) === t).sort()
  if (same.length && !opts.fresh) return join(EXP, same[same.length - 1])
  return join(EXP, `${today()}-${t}`)
}

/**
 * Throws when `dir` is in the eval root but outside its areas: a config's old `out`
 * ("/data1/websfm_eval/night-2026-11-06/…") would make a new folder at the top level.
 * A folder outside the eval root (bench-out/, a scratch disk) is the caller's choice.
 */
export function checkOut(dir, what = 'out') {
  const p = resolve(dir)
  if (relative(EVAL, p).startsWith('..') || p === EVAL) {
    if (p === EVAL) throw new Error(`${what} is the eval root itself (${EVAL})`)
    return p
  }
  if (EVAL === join(repo, 'bench-out')) return p // no eval disk: bench-out is a scratch folder
  if (RUN_AREAS.some((a) => p === a || p.startsWith(a + sep))) return p
  throw new Error(
    `${what} ${p} is loose in ${EVAL}. Runs go in exp/, results/ or ref/: ` +
      `npm run bench -- run <tool> <config> --exp <topic> (it sets the folder), ` +
      `or drop "${what}" from the config.`,
  )
}

/** The default output of a run started outside the CLI: today's scratch experiment. */
export function scratchOut(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(11, 19)
  return join(EXP, `${today()}-scratch`, `${name}-${stamp}`)
}
