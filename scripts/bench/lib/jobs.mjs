// How each tool runs one job: the command lines, in order, and where its summary lands.
// The scoreboard and `bench run` both start jobs through here, so an experiment and a
// cited result of the same job run the same commands.
//
// A job: { id, tool, config, args?, checkpoints?, truth?, eth3d? } (scoreboard.json's
// fields). Tools: websfm (run-bench.mjs), metashape (ref/metashape.mjs; `checkpoints`
// scores the config's GCP marks), metashape-hist and colmap-hist (the film blocks),
// metashape-dense (Metashape's cloud from ETH3D's cameras), colmap (ref/colmap.mjs), odm
// (ref/odm.mjs). `truth` adds the camera check, `eth3d` both dense scorers.

import { spawn } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PYTHON, SHARED, repo } from './paths.mjs'
import { writeRecord } from './record.mjs'

export const TOOLS = ['websfm', 'metashape', 'metashape-hist', 'metashape-dense', 'colmap', 'colmap-hist', 'odm']

// Where each tool's runner writes its summary in the job folder (else summary.json).
export const SUMMARY_FILE = { 'websfm': 'run.json', 'metashape-dense': 'metashape.json' }
// Where a tool's dense cloud lands in its job folder (else dense.ply).
const CLOUD_FILE = { websfm: 'run.dense.bin', colmap: 'dense/fused.ply' }
// The thinned ETH3D scans, built once per scene by eth3d_score.py (a minute each) and kept.
const ETH3D_GT_CACHE = process.env.ETH3D_GT_CACHE ?? join(SHARED, 'eth3d-gt-cache')

// A config by name (scripts/bench/configs/<name>.json, local) or by path ("….json").
export const configPath = (name) =>
  name.endsWith('.json') ? resolve(repo, name) : join(repo, 'scripts/bench/configs', `${name}.json`)
export const loadConfig = async (name) => JSON.parse(await readFile(configPath(name), 'utf8'))
const epsgOf = (crs) => String(crs ?? '').replace(/^EPSG:+/i, '')

/**
 * The tool's own steps for `job` in `dir`.
 * @returns {Promise<{ summary: string, log?: string, steps: any[][] }>}
 */
async function toolCommandsOf(job, dir) {
  const cfg = await loadConfig(job.config)
  const extra = job.args ?? []
  const node = (script, argv) => [process.execPath, [join(repo, 'scripts/bench', script), ...argv]]
  switch (job.tool) {
    case 'websfm':
      return {
        summary: join(dir, 'run.json'),
        log: join(dir, 'run.log'),
        steps: [
          node('websfm/run-bench.mjs', ['--config', configPath(job.config), '--out', join(dir, 'run'), ...extra]),
        ],
      }
    case 'metashape': {
      const steps = [
        node('ref/metashape.mjs', ['--config', configPath(job.config), '--ws', dir, '--name', job.id, ...extra]),
      ]
      if (job.checkpoints) {
        // The GCPs as checkpoints: GeoScan-style (reference.gcps + a Metashape project's
        // marks), or the bench's gcp.csv (hist.gcps) when WebSfM holds every GCP a check too.
        const ref = cfg.reference ?? {}
        const h = cfg.hist ?? {}
        let source
        if (ref.gcps && ref.metashape) source = ['--gcps', ref.gcps, '--marks', ref.metashape]
        else if (h.gcps && Array.isArray(h.control) && h.control.length === 0) source = ['--gcp-csv', h.gcps]
        else
          throw new Error(
            `${job.id}: checkpoints need reference.gcps + reference.metashape, or hist.gcps with control []`,
          )
        steps.push([
          PYTHON,
          [
            join(repo, 'scripts/bench/ref/metashape_checkpoints.py'),
            ...['--project', join(dir, 'project.psx'), ...source],
            ...(ref.excludeGcps?.length ? ['--exclude', ...ref.excludeGcps] : []),
            ...['--out', join(dir, 'checkpoints.json')],
          ],
        ])
      }
      return { summary: join(dir, 'summary.json'), steps }
    }
    case 'metashape-hist': {
      const h = cfg.hist ?? {}
      const argv = [join(repo, 'scripts/bench/hist/metashape_hist.py'), '--images', cfg.images, '--ws', dir]
      if (h.mask) argv.push('--mask', h.mask)
      if (h.gcps) argv.push('--gcps', h.gcps)
      if (h.intrinsics) argv.push('--intrinsics', h.intrinsics)
      if (cfg.crs) argv.push('--epsg', epsgOf(cfg.crs))
      if (h.refDem) argv.push('--ref-dem', h.refDem)
      // The DEM at the resolution WebSfM's run makes it (the config's dem.gsd), so the scores compare.
      if (cfg.dem?.gsd) argv.push('--dem-res', String(cfg.dem.gsd))
      return { summary: join(dir, 'summary.json'), steps: [[PYTHON, [...argv, ...extra]]] }
    }
    case 'colmap-hist': {
      const h = cfg.hist ?? {}
      const argv = [join(repo, 'scripts/bench/hist/colmap_hist.py'), '--images', cfg.images, '--ws', dir]
      if (h.mask) argv.push('--mask', h.mask)
      if (!h.gcps) throw new Error(`${job.id}: colmap-hist needs hist.gcps in its config`)
      argv.push('--gcps', h.gcps)
      if (h.intrinsics) argv.push('--intrinsics', h.intrinsics)
      if (cfg.crs) argv.push('--epsg', epsgOf(cfg.crs))
      if (h.refDem) argv.push('--ref-dem', h.refDem)
      // The DEM at the resolution WebSfM's run makes it (the config's dem.gsd), so the scores compare.
      if (cfg.dem?.gsd) argv.push('--dem-res', String(cfg.dem.gsd))
      return { summary: join(dir, 'summary.json'), steps: [[PYTHON, [...argv, ...extra]]] }
    }
    case 'metashape-dense': {
      if (!job.eth3d) throw new Error(`${job.id}: metashape-dense needs eth3d (the scene folder)`)
      const argv = [join(repo, 'scripts/bench/ref/metashape_dense.py'), '--scene', job.eth3d, '--ws', dir]
      return { summary: join(dir, 'metashape.json'), steps: [[PYTHON, [...argv, ...extra]]] }
    }
    case 'colmap':
      return {
        summary: join(dir, 'summary.json'),
        steps: [node('ref/colmap.mjs', ['--config', configPath(job.config), '--ws', dir, '--name', job.id, ...extra])],
      }
    case 'odm':
      return {
        summary: join(dir, 'summary.json'),
        steps: [node('ref/odm.mjs', ['--config', configPath(job.config), '--ws', dir, ...extra])],
      }
    default:
      throw new Error(`${job.id}: unknown tool ${job.tool} (one of ${TOOLS.join(', ')})`)
  }
}

/**
 * Every step of `job` in `dir`: the tool's, then the camera check against `truth` and the
 * two ETH3D dense scorers when the job names them. A scoring step carries `creates`, the
 * file it writes, so a missing score can run on an old job alone.
 */
export async function commandsOf(job, dir) {
  const c = await toolCommandsOf(job, dir)
  if (job.truth)
    c.steps.push([
      process.execPath,
      [join(repo, 'scripts/bench/score/camera-check.mjs'), c.summary, job.truth],
      { stdout: join(dir, 'camera-check.json'), creates: join(dir, 'camera-check.json') },
    ])
  if (job.eth3d) {
    const cloud = CLOUD_FILE[job.tool] ? join(dir, CLOUD_FILE[job.tool]) : join(dir, 'dense.ply')
    c.steps.push([
      PYTHON,
      [
        join(repo, 'scripts/bench/score/eth3d_score.py'),
        ...['--scene', job.eth3d, '--recon', cloud, '--occlusion', 'min', '--label', job.id],
        ...['--cache', ETH3D_GT_CACHE, '--out', join(dir, 'eth3d.json')],
      ],
      { creates: join(dir, 'eth3d.json') },
    ])
    c.steps.push([
      PYTHON,
      [
        join(repo, 'scripts/bench/score/eth3d_official.py'),
        ...['--scene', job.eth3d, '--recon', cloud, '--label', job.id, '--out', join(dir, 'eth3d-official.json')],
      ],
      { creates: join(dir, 'eth3d-official.json') },
    ])
  }
  return c
}

/**
 * Run one command line, its output appended to `logFile`. `opts.stdout`: a file that
 * takes the step's standard output alone (a JSON line). `opts.echo`: also to this terminal.
 */
export function runStep(exe, argv, logFile, opts = {}) {
  return new Promise((done) => {
    const p = spawn(exe, argv, { cwd: repo, env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } })
    const write = (b) => {
      if (opts.echo) process.stdout.write(b)
      return appendFile(logFile, b)
    }
    let stdout = ''
    p.stdout.on('data', opts.stdout ? (b) => (stdout += b) : write)
    p.stderr.on('data', write)
    p.on('close', async (code) => {
      if (opts.stdout) await writeFile(opts.stdout, stdout)
      done(code ?? 1)
    })
  })
}

/**
 * Run `job` into `dir`: its steps in order (stopping at the first that fails), the log in
 * <dir>/console.log, then <dir>/record.json with the conditions it ran under.
 * @param {object} job
 * @param {string} dir
 * @param {{ echo?: boolean, extra?: object }} [opts] `extra`: more fields for the record
 * @returns {Promise<number>} the exit code
 */
export async function runJob(job, dir, opts = {}) {
  const { summary, log, steps } = await commandsOf(job, dir)
  await mkdir(dir, { recursive: true })
  const startedAt = new Date().toISOString()
  let code = 0
  for (const [exe, argv, o] of steps) {
    code = await runStep(exe, argv, join(dir, 'console.log'), { ...o, echo: opts.echo })
    if (code !== 0) break
  }
  const cfg = await loadConfig(job.config).catch(() => null)
  await writeRecord(dir, {
    tool: job.tool,
    config: job.config,
    configPath: configPath(job.config),
    cfg,
    summary,
    log,
    startedAt,
    exit: code,
    steps: steps.map(([exe, argv]) => [exe, ...argv]),
    extra: { job: job.id, ...(opts.extra ?? {}) },
  })
  return code
}
