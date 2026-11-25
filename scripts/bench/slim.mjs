// Slimming a finished run to its evidence: `npm run bench -- clean --slim <folder>`.
//
// A run's numbers live in a few small files (summaries, logs, notes, scores, configs). The
// rest is workspace (browser profiles, app builds, photos, rasters, clouds, Metashape and
// COLMAP projects): hundreds of GB that only a rerun or a look at the products needs. A
// slimmed folder keeps what a reader needs to check a number and loses the rest.

import { existsSync, lstatSync, readdirSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const EVIDENCE = /\.(json|jsonl|log|txt|md|csv|tsv|sh|py|mjs|js|stdout|out|ya?ml|tex|diff|patch|tar\.gz)$/i
/** Folders that are workspace as a whole, whatever their files. */
export const WORKSPACE_DIR = /\.(build|files|downloads)$|^profile|-profile$/i
const SMALL = 64 * 1024
const EVIDENCE_MAX = 20 * 2 ** 20

/** Whether a slimmed folder keeps a file: any small file, and evidence up to 20 MiB. */
export function slimKeeps(name, size) {
  return size <= SMALL || (EVIDENCE.test(name) && size <= EVIDENCE_MAX)
}

const list = (d) => (existsSync(d) ? readdirSync(d) : [])

/** Bytes under `p` (symlinks counted as links, never followed). */
export function sizeOf(p) {
  const s = lstatSync(p)
  if (!s.isDirectory()) return s.size
  let n = 0
  for (const e of list(p)) n += sizeOf(join(p, e))
  return n
}

/**
 * Delete the workspace in `dir` and keep the evidence. With `act` false, only counts.
 * @returns {Promise<number>} the bytes freed (or that would be)
 */
export async function slim(dir, act) {
  let freed = 0
  const walk = async (d) => {
    for (const e of list(d)) {
      const p = join(d, e)
      const s = lstatSync(p)
      if (s.isDirectory()) {
        if (WORKSPACE_DIR.test(e)) {
          freed += sizeOf(p)
          if (act) await rm(p, { recursive: true, force: true })
        } else await walk(p)
      } else if (!slimKeeps(e, s.size)) {
        freed += s.size
        if (act) await rm(p, { force: true })
      }
    }
    if (act && d !== dir && list(d).length === 0) await rm(d, { recursive: true, force: true })
  }
  await walk(dir)
  if (act)
    await writeFile(
      join(dir, 'SLIMMED.txt'),
      `Workspace removed ${new Date().toISOString().slice(0, 10)} (npm run bench -- clean --slim): ` +
        `profiles, builds, photos, rasters, clouds and tool projects. Summaries, logs and notes stay.\n`,
    )
  return freed
}
