// The console's executor: one typed line → resolve, guard, act. Pure in the sense that
// matters here: everything it touches arrives in `env`, so the whole dispatch, verbs
// included, is unit-tested with a fake (console.test.js). The impure environment is
// composables/useConsoleEnv.js; the registry is commands.js.
//
// env: {
//   log(message, level), clear(), state() → commandState (NEED_CHECKS fields),
//   dispatch(id, value)                       the ribbon's handleCommand
//   workflows() → [{ id, name, blocks }]       the project's saved workflows
//   startWorkflow(workflow) → Promise<boolean> the workflow runner's start()
//   workflowStatus() → { running, pause }, respond(action), stopWorkflow()
//   stats() → snapshot (statsLines), images() → [{ id, uuid, name }],
//   matchPairs() → [{ nameA, nameB, idA, idB, inliers, enabled, weak, used }]
//   pairState(uuidA, uuidB) → { pid, enabled, inliers } | null, setPairEnabled(pid, on)
//   selectImage(id)
//   tuning: { get(group) → overrides, set(group, path, value | undefined) }
// }

import { resolveCommand, consoleReason, helpLines, helpFor, getCommand, RUN_STAGES } from './commands.js'
import { createWorkflow } from '../workflow.js'
import { stepValue } from './ribbonTabs.js'
import { TUNING_GROUPS, parseTuningKey, parseTuningValue, getPath, tuningKeys } from './consoleSettings.js'

/** Split arguments on whitespace, keeping "quoted names" together. */
export function splitArgs(text) {
  const out = []
  for (const m of String(text ?? '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3])
  return out
}

// The raw text after the first `n` tokens (so quoted arguments survive).
function restAfter(line, n) {
  return line.trim().replace(new RegExp(`^(?:\\S+\\s*){${n}}`), '')
}

/**
 * An image by name: exact (any case), else the one name starting with it, else the
 * one containing it. → { image } | { error }.
 */
export function findImage(images, query) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
  if (!q) return { error: 'Give an image name' }
  const exact = images.filter((i) => i.name.toLowerCase() === q)
  if (exact.length === 1) return { image: exact[0] }
  for (const match of [(i) => i.name.toLowerCase().startsWith(q), (i) => i.name.toLowerCase().includes(q)]) {
    const hits = images.filter(match)
    if (hits.length === 1) return { image: hits[0] }
    if (hits.length > 1) {
      return {
        error: `"${query}" matches ${hits.length} images: ${hits
          .slice(0, 5)
          .map((i) => i.name)
          .join(', ')}${hits.length > 5 ? ', …' : ''}`,
      }
    }
  }
  return { error: `No image named "${query}"` }
}

const fmtN = (n) => (Number.isFinite(n) ? n.toLocaleString('en') : '—')

/** The `stats` overview of a project snapshot (useConsoleEnv builds it). */
export function statsLines(s) {
  const lines = []
  lines.push(`Images: ${fmtN(s.images)} (${fmtN(s.detected)} with keypoints, ${fmtN(s.keypoints)} keypoints)`)
  const p = s.pairs ?? {}
  lines.push(
    `Pairs: ${fmtN(p.verified)} verified of ${fmtN(p.total)} matched` +
      `${p.excluded ? `, ${fmtN(p.excluded)} excluded` : ''}${p.weak ? `, ${fmtN(p.weak)} weak` : ''}${p.failed ? `, ${fmtN(p.failed)} failed` : ''}`,
  )
  lines.push(
    s.sparse
      ? `Sparse model: ${fmtN(s.sparse.cameras)} of ${fmtN(s.images)} images registered, ${fmtN(s.sparse.points)} points`
      : 'Sparse model: none',
  )
  if (s.depthMaps) lines.push(`Depth maps: ${fmtN(s.depthMaps)}`)
  for (const c of s.dense ?? []) lines.push(`Dense cloud "${c.name}": ${fmtN(c.points)} points`)
  for (const m of s.meshes ?? [])
    lines.push(`Mesh "${m.name}": ${fmtN(m.triangles)} triangles${m.textured ? ', textured' : ''}`)
  for (const [label, r] of [
    ['DEM', s.dem],
    ['Orthophoto', s.ortho],
  ]) {
    if (r)
      lines.push(
        `${label}: ${fmtN(r.width)} × ${fmtN(r.height)} cells${r.gsd ? ` at ${r.gsd.toPrecision(3)} ${r.unit}` : ''}`,
      )
  }
  if (s.gcps) lines.push(`Control points and markers: ${fmtN(s.gcps)}`)
  if (s.measurements) lines.push(`Saved measurements: ${fmtN(s.measurements)}`)
  lines.push(`Frame: ${s.frame}`)
  return lines
}

/** `stats matches`: the match graph in a few lines. */
export function matchStatsLines(pairs, images) {
  const verified = pairs.filter((p) => p.enabled && !p.weak)
  const lines = [
    `${fmtN(verified.length)} verified pairs over ${fmtN(images.length)} images` +
      `${pairs.some((p) => p.weak) ? `, ${fmtN(pairs.filter((p) => p.weak).length)} weak (PnP bridges only)` : ''}`,
  ]
  if (verified.length) {
    const inl = verified.map((p) => p.inliers).sort((a, b) => a - b)
    lines.push(
      `Inliers per pair: min ${fmtN(inl[0])}, median ${fmtN(inl[Math.floor(inl.length / 2)])}, max ${fmtN(inl[inl.length - 1])}`,
    )
    const degree = new Map(images.map((i) => [i.id, 0]))
    for (const p of verified) {
      degree.set(p.idA, (degree.get(p.idA) ?? 0) + 1)
      degree.set(p.idB, (degree.get(p.idB) ?? 0) + 1)
    }
    const isolated = images.filter((i) => !degree.get(i.id))
    if (isolated.length) {
      lines.push(
        `No verified pair: ${isolated
          .slice(0, 8)
          .map((i) => i.name)
          .join(', ')}${isolated.length > 8 ? ` and ${isolated.length - 8} more` : ''}`,
      )
    }
    const weakest = [...verified].sort((a, b) => a.inliers - b.inliers).slice(0, 5)
    lines.push(`Weakest: ${weakest.map((p) => `${p.nameA} ↔ ${p.nameB} (${fmtN(p.inliers)})`).join(', ')}`)
  }
  const excluded = pairs.filter((p) => !p.enabled)
  if (excluded.length) {
    lines.push(
      `Excluded by you: ${excluded
        .slice(0, 8)
        .map((p) => `${p.nameA} ↔ ${p.nameB}`)
        .join(', ')}${excluded.length > 8 ? ', …' : ''}`,
    )
  }
  return lines
}

/** Argument completions per verb, for Tab: tuning keys, run stages, image names. */
export function argCompletionsFor(env) {
  const groups = Object.keys(TUNING_GROUPS)
  return {
    set: () => [...groups, ...groups.flatMap((g) => tuningKeys(g))],
    run: () => [
      'workflow',
      ...new Set(Object.keys(RUN_STAGES)),
      ...(env?.workflows?.() ?? []).map((w) => `workflow ${w.name}`),
    ],
    select: () => (env?.images?.() ?? []).map((i) => i.name),
    pair: () => ['disable', 'enable'],
    help: () => ['all'],
  }
}

export function runConsoleLine(raw, env) {
  const line = String(raw ?? '').trim()
  if (!line) return
  const log = (m, level = 'info') => env.log(m, level)
  log(`› ${line}`)

  const res = resolveCommand(line)
  if (res.error === 'unknown') {
    const hint = res.suggestions?.length ? ` Did you mean: ${res.suggestions.join(', ')}?` : ''
    log(`Unknown command: ${res.name}.${hint} Type "help".`, 'error')
    return
  }
  if (res.error) return
  const { cmd } = res
  const reason = consoleReason(cmd, env.state?.() ?? {})
  if (reason) {
    log(reason, 'warn')
    return
  }
  const rest = restAfter(line, res.name.split(' ').length)

  if (cmd.verb) {
    VERB_HANDLERS[cmd.verb](rest, env, log, cmd)
    return
  }

  // A ribbon stepper takes its value as the argument ("point size 4").
  if (cmd.stepper) {
    const v = Number(splitArgs(rest)[0])
    const { min, max } = cmd.stepper
    if (!rest || !Number.isFinite(v) || v < min || v > max) {
      usage(cmd, log)
      return
    }
    env.dispatch(cmd.dispatch, stepValue(cmd.stepper, v, 0)) // snapped to the ribbon's step
    return
  }
  if (rest) log(`Ignoring extra arguments: ${rest}`, 'debug')
  env.dispatch(cmd.dispatch)
}

function usage(cmd, log) {
  for (const u of cmd.usage ?? [cmd.name]) log(`Usage: ${u}`, 'warn')
}

const VERB_HANDLERS = {
  help(rest, env, log) {
    const topic = rest.trim()
    if (!topic) {
      log('Commands (type "help <command>" for its usage):')
      for (const l of helpLines()) log(l)
      return
    }
    const lines = getCommand(topic) ? helpFor(topic) : helpLines(topic)
    if (!lines) {
      log(`No such command or tab: ${topic}`, 'error')
      return
    }
    for (const l of lines) log(l)
  },

  clear(rest, env) {
    env.clear()
  },

  run(rest, env, log, cmd) {
    const args = splitArgs(rest)
    if (!args.length) {
      usage(cmd, log)
      return
    }
    let workflow
    if (args[0].toLowerCase() === 'workflow') {
      const name = restAfter(rest, 1)
        .replace(/^(["'])(.*)\1$/, '$2')
        .trim()
      const all = env.workflows?.() ?? []
      if (!name) {
        log(`Usage: run workflow <name>   (${all.map((w) => w.name).join(', ') || 'no saved workflows'})`, 'warn')
        return
      }
      const q = name.toLowerCase()
      const exact = all.filter((w) => w.name.toLowerCase() === q)
      const hits = exact.length ? exact : all.filter((w) => w.name.toLowerCase().startsWith(q))
      if (hits.length !== 1) {
        log(
          hits.length
            ? `"${name}" matches ${hits.map((w) => w.name).join(', ')}`
            : `No workflow named "${name}" — saved: ${all.map((w) => w.name).join(', ') || 'none'}`,
          'error',
        )
        return
      }
      workflow = hits[0]
    } else {
      const unknown = args.filter((a) => !RUN_STAGES[a.toLowerCase()])
      if (unknown.length) {
        log(
          `Unknown stage${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} — stages: ${[...new Set(Object.keys(RUN_STAGES))].join(' ')}`,
          'error',
        )
        return
      }
      // An explicit `run` always runs: the stages re-run even where output exists.
      workflow = createWorkflow(
        `Console: ${args.join(' ')}`,
        args.map((a) => RUN_STAGES[a.toLowerCase()]),
      )
      workflow.defaults.reusePolicy = 'rerun'
    }
    const status = env.workflowStatus?.() ?? {}
    if (status.running || status.pause) {
      log('A workflow is already running or paused — "stop" it first', 'warn')
      return
    }
    log(
      `Running ${workflow.name.startsWith('Console: ') ? workflow.blocks.map((b) => b.type).join(' → ') : `workflow "${workflow.name}"`}`,
    )
    Promise.resolve(env.startWorkflow(workflow)).then((ok) => {
      const pause = env.workflowStatus?.().pause
      if (!ok && pause?.kind === 'blocked') {
        log(`Workflow blocked: ${pause.message}`, 'error')
        env.respond('dismiss')
      }
    })
  },

  continue(rest, env, log) {
    respondTo('continue', env, log)
  },
  reuse(rest, env, log) {
    respondTo('reuse', env, log)
  },
  stop(rest, env, log) {
    const status = env.workflowStatus?.() ?? {}
    if (!status.running && !status.pause) {
      log('No workflow is running', 'warn')
      return
    }
    env.stopWorkflow()
    log('Stopping the workflow…')
  },

  stats(rest, env, log, cmd) {
    const what = rest.trim().toLowerCase()
    if (what && what !== 'matches') {
      usage(cmd, log)
      return
    }
    const lines = what === 'matches' ? matchStatsLines(env.matchPairs(), env.images()) : statsLines(env.stats())
    for (const l of lines) log(l)
  },

  set(rest, env, log) {
    const args = splitArgs(rest)
    if (!args.length) {
      let any = false
      for (const g of Object.keys(TUNING_GROUPS)) {
        for (const key of tuningKeys(g)) {
          const v = getPath(env.tuning.get(g), key.split('.').slice(1))
          if (v !== undefined) {
            any = true
            log(
              `${key} = ${JSON.stringify(v)} (default ${JSON.stringify(getPath(TUNING_GROUPS[g].defaults, key.split('.').slice(1)))})`,
            )
          }
        }
      }
      if (!any) log(`No overrides. Groups: ${Object.keys(TUNING_GROUPS).join(', ')} — "set sfm" lists its keys.`)
      return
    }
    const key = parseTuningKey(args[0])
    if (key.error) {
      log(key.error, 'error')
      return
    }
    const current = (path) => {
      const o = getPath(env.tuning.get(key.group), path)
      return o !== undefined ? o : getPath(TUNING_GROUPS[key.group].defaults, path)
    }
    if (args.length === 1) {
      // A group (or the group itself): list its keys with their values.
      const prefix = [key.group, ...key.path].join('.')
      const keys = tuningKeys(key.group).filter((k) => k === prefix || k.startsWith(`${prefix}.`))
      for (const k of keys) {
        const path = k.split('.').slice(1)
        const o = getPath(env.tuning.get(key.group), path)
        log(
          `${k} = ${JSON.stringify(current(path))}${o !== undefined ? `  (set; default ${JSON.stringify(getPath(TUNING_GROUPS[key.group].defaults, path))})` : ''}`,
        )
      }
      return
    }
    const name = [key.group, ...key.path].join('.')
    const raw = restAfter(rest, 1)
    const old = current(key.path)
    if (/^(default|reset|unset)$/i.test(raw.trim())) {
      env.tuning.set(key.group, key.path, undefined)
      log(`${name}: ${JSON.stringify(old)} → ${JSON.stringify(current(key.path))} (default)`, 'success')
      return
    }
    const value = parseTuningValue(raw, key.def)
    if (value.error) {
      log(`${name} ${value.error}`, 'error')
      return
    }
    env.tuning.set(key.group, key.path, value.value)
    log(
      `${name}: ${JSON.stringify(old)} → ${JSON.stringify(value.value)} (default ${JSON.stringify(key.def)}) — ` +
        `applies to ${TUNING_GROUPS[key.group].appliesTo}, this session only`,
      'success',
    )
  },

  pair(rest, env, log, cmd) {
    const args = splitArgs(rest)
    const action = args[0]?.toLowerCase()
    if (!['disable', 'enable'].includes(action) || args.length !== 3) {
      usage(cmd, log)
      return
    }
    const images = env.images()
    const a = findImage(images, args[1]),
      b = findImage(images, args[2])
    for (const r of [a, b])
      if (r.error) {
        log(r.error, 'error')
        return
      }
    if (a.image.id === b.image.id) {
      log('Give two different images', 'error')
      return
    }
    const pair = env.pairState(a.image.uuid, b.image.uuid)
    const label = `${a.image.name} ↔ ${b.image.name}`
    if (!pair) {
      log(`No verified pair ${label}`, 'error')
      return
    }
    const on = action === 'enable'
    if (pair.enabled === on) {
      log(`${label} is already ${on ? 'included in' : 'excluded from'} reconstruction`)
      return
    }
    env.setPairEnabled(pair.pid, on)
    log(
      `${label} (${fmtN(pair.inliers)} inliers) ${on ? 'restored to' : 'excluded from'} reconstruction — takes effect on the next Sparse Model run`,
      'success',
    )
  },

  select(rest, env, log) {
    const name = rest.replace(/^(["'])(.*)\1$/, '$2')
    const r = findImage(env.images(), name)
    if (r.error) {
      log(r.error, 'error')
      return
    }
    env.selectImage(r.image.id)
    log(`Selected ${r.image.name}`)
  },
}

function respondTo(action, env, log) {
  const pause = env.workflowStatus?.().pause
  if (!pause || pause.kind === 'blocked') {
    log('No workflow is waiting', 'warn')
    return
  }
  if (action === 'reuse' && pause.kind !== 'reuse') {
    log('The workflow is not asking about existing output — "continue" or "stop"', 'warn')
    return
  }
  env.respond(action)
}
