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
//   matchPairs() → [{ nameA, nameB, idA, idB, inliers, enabled, weak, used, check, held }]
//                  check: the main model's verdict (pairAgreement.js pairCheckVerdicts) or null;
//                  held: the photo a 'holds' pair holds
//   pairState(uuidA, uuidB) → { pid, enabled, inliers } | null, setPairEnabled(pid, on)
//   selectImage(id)
//   items(list) → [{ id, name }] for a list of core/help/consoleEdits.js (images, gcps …)
//   edit(noun, action, args) → a reply line, or nothing (the store logs the Activity line)
//   language() → id, languages() → [{ id, label, preview? }], setLanguage(id)
//   tuning: { get(group) → overrides, set(group, path, value | undefined) }
// }

import { resolveCommand, consoleReason, helpLines, helpFor, getCommand } from './commands.js'
import { RUN_STAGE_NAMES, parseRunArgs, runStageHelp } from './consoleRun.js'
import { EDITS, parseEditArgs, findNamed, quoteArg } from './consoleEdits.js'
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

/** An image by name (consoleEdits.js findNamed). → { image } | { error }. */
export function findImage(images, query) {
  const r = findNamed(images, query, 'image')
  return r.error ? r : { image: r.item }
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
  // The main model's check of every pair (Sparse Model ▸ pair check).
  const checked = pairs.filter((p) => p.check)
  if (checked.length) {
    const n = (v) => checked.filter((p) => p.check === v).length
    const holds = checked.filter((p) => p.check === 'holds').sort((a, b) => b.inliers - a.inliers)
    lines.push(
      `Model check: ${fmtN(n('agrees'))} agree, ${fmtN(checked.length - n('agrees'))} disagree ` +
        `(${fmtN(holds.length)} may be false, ${fmtN(n('overruled'))} overruled by the model)`,
    )
    if (holds.length) {
      lines.push(
        `May be false: ${holds
          .slice(0, 8)
          .map((p) => `${p.nameA} ↔ ${p.nameB} (holds ${p.held ?? '?'})`)
          .join(', ')}${holds.length > 8 ? `, and ${fmtN(holds.length - 8)} more` : ''}`,
      )
      lines.push(
        `Exclude one with: pair disable ${quoteArg(holds[0].nameA)} ${quoteArg(holds[0].nameB)}, then run Sparse Model again`,
      )
    }
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
    run: () => ['workflow', ...RUN_STAGE_NAMES, ...(env?.workflows?.() ?? []).map((w) => `workflow ${w.name}`)],
    select: () => (env?.images?.() ?? []).map((i) => i.name),
    pair: () => ['disable', 'enable'],
    help: () => ['all', 'edit', ...EDITS.map((e) => e.noun), ...RUN_STAGE_NAMES.map((n) => `run ${n}`)],
    // An edit command completes the names of its list (quoted when they have spaces).
    // An edit command completes the name being typed: the arguments before it stay.
    edit: (rest, cmd) => {
      const e = EDITS.find((x) => x.noun === cmd?.edit?.noun)
      if (!e) return []
      const done = splitArgs(rest).length - (/\s$/.test(rest) || !rest ? 0 : 1)
      const kind = e.actions[cmd.edit.action].args[Math.min(done, e.actions[cmd.edit.action].args.length - 1)] ?? ''
      const list = /^images/.test(kind) ? 'images' : /^gcp/.test(kind) ? 'gcps' : /^item/.test(kind) ? e.list : null
      // The token being typed: the last one, unless a space closed it.
      const last = [...rest.matchAll(/"[^"]*"?|'[^']*'?|\S+/g)].at(-1)
      const part = last && last.index + last[0].length === rest.length ? last[0] : ''
      const head = rest.slice(0, rest.length - part.length)
      const q = part.replace(/^["']/, '').toLowerCase()
      return (env?.items?.(list) ?? [])
        .filter((i) => String(i.name).toLowerCase().startsWith(q))
        .map((i) => `${head}${quoteArg(i.name)}`)
    },
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
    const stage = topic.match(/^run\s+(\S+)$/i)
    const lines = stage ? runStageHelp(stage[1]) : getCommand(topic) ? helpFor(topic) : helpLines(topic)
    if (!lines) {
      log(`No such command or tab: ${topic}`, 'error')
      return
    }
    for (const l of lines) log(l)
  },

  clear(rest, env) {
    env.clear()
  },

  // The interface language: a preview language (partly translated) is only chosen here
  // or in Settings ▸ General ▸ Language.
  lang(rest, env, log) {
    const all = env.languages?.() ?? []
    const id = rest.trim().toLowerCase()
    const name = (l) => `${l.id} (${l.label}${l.preview ? ', preview: partly translated' : ''})`
    if (!id) {
      log(`Language: ${env.language?.() ?? 'en'}. Available: ${all.map(name).join(', ')}`)
      return
    }
    const lang = all.find((l) => l.id === id)
    if (!lang) {
      log(`No such language: ${id}. Available: ${all.map((l) => l.id).join(', ')}`, 'error')
      return
    }
    env.setLanguage(id)
    log(`Language set to ${name(lang)}; this browser remembers it.`)
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
      const parsed = parseRunArgs(args)
      if (parsed.error) {
        log(parsed.error, 'error')
        return
      }
      // An explicit `run` always runs: the stages re-run even where output exists.
      workflow = createWorkflow(
        `Console: ${args.join(' ')}`,
        parsed.stages.map((st) => st.id),
      )
      workflow.blocks.forEach((b, i) => Object.assign(b.settings, parsed.stages[i].settings))
      workflow.defaults.reusePolicy = 'rerun'
    }
    const status = env.workflowStatus?.() ?? {}
    if (status.running || status.pause) {
      log('A workflow is already running or paused — "stop" it first', 'warn')
      return
    }
    log(
      `Running ${workflow.name.startsWith('Console: ') ? workflow.blocks.map((b) => b.type).join(' → ') : `workflow "${workflow.name}"`}` +
        (workflow.name.startsWith('Console: ') && /=/.test(rest) ? ` (${restAfter(rest, 0)})` : ''),
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
      log(`${name}: ${JSON.stringify(old)} → ${JSON.stringify(current(key.path))} (default)`, 'info')
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
      'info',
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
      'info',
    )
  },

  // An edit made by hand (consoleEdits.js): read the arguments, then let the store make
  // it, which logs the Activity line.
  edit(rest, env, log, cmd) {
    const e = EDITS.find((x) => x.noun === cmd.edit.noun)
    const parsed = parseEditArgs(e, cmd.edit.action, splitArgs(rest), (list) => env.items(list))
    if (parsed.error) {
      if (parsed.error === 'usage') usage(cmd, log)
      else log(parsed.error, 'error')
      return
    }
    const reply = env.edit(e.noun, cmd.edit.action, parsed.args)
    if (reply) log(reply.text ?? reply, reply.level ?? 'info')
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
