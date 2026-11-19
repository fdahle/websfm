// Console commands for the edits a user makes by hand: rename a photo, disable a GCP,
// set a product as main… (docs/conventions.md ▸ The console ▸ Everything can be typed).
// Each is `<noun> <action> <arguments>` ("gcp disable GCP 3" with the name quoted when
// it has spaces), its own command in the console's Edit group. An edit confirmed in the
// Activity tab names its command (`editCommand` below); a unit test checks that every
// Activity line does and that the command resolves.
//
// Pure: the table, the argument parser and the command writer. The executor
// (console.js ▸ edit) resolves names against `env.items(list)` and runs
// `env.edit(noun, action, args)` (composables/useConsoleEnv.js), whose store call logs
// the Activity line itself.

// Argument kinds, in the order typed:
//   item     one existing object of the noun's list, by name
//   items    one or more of them
//   images   one or more photos, by name
//   name     a new name (one argument: quote it when it has spaces)
//   number   a number
//   numbers6 six numbers
//   choice   one of `options`
//   fields   key=value pairs (a value is a number, true/false, or text)
export const EDITS = [
  {
    noun: 'project',
    needs: ['project'],
    actions: {
      type: {
        args: ['choice'],
        options: ['aerial', 'object'],
        help: 'Set the capture type, aerial survey or object capture: the defaults that depend on it follow',
      },
    },
  },
  {
    noun: 'image',
    list: 'images',
    needs: ['images'],
    actions: {
      rename: { args: ['item', 'name'], help: 'Rename a photo' },
      enable: { args: ['items'], help: 'Enable photos: later runs use them again' },
      disable: { args: ['items'], help: 'Disable photos: later runs leave them out' },
    },
  },
  {
    noun: 'group',
    list: 'groups',
    needs: ['images'],
    actions: {
      create: { args: ['name', 'images?'], help: 'Create an image group, with photos in it' },
      rename: { args: ['item', 'name'], help: 'Rename an image group' },
      remove: { args: ['item'], help: 'Remove an image group (its photos stay, ungrouped)' },
      add: { args: ['item', 'images'], help: 'Move photos into an image group' },
      ungroup: { args: ['images'], help: 'Take photos out of their group' },
    },
  },
  {
    noun: 'sensor',
    list: 'sensors',
    needs: ['sensors'],
    actions: {
      set: {
        args: ['item', 'fields'],
        help: 'Set sensor fields: kind=film|digital, label, focalMm, ppxMm, ppyMm, gnssLeverArmX|Y|Z (m)',
      },
      film: { args: ['item', 'number'], help: 'Set the film format of a film sensor, width in mm' },
      assign: { args: ['item', 'images'], help: 'Move photos to a sensor' },
      new: { args: ['images'], help: 'Put photos on a new sensor of their own' },
    },
  },
  {
    noun: 'product',
    list: 'products',
    needs: ['project'],
    actions: {
      main: { args: ['item'], help: 'Set a model, cloud, mesh, DEM or orthophoto as the main one' },
      rename: { args: ['item', 'name'], help: 'Rename a product' },
      remove: { args: ['item'], help: 'Remove a product' },
      show: { args: ['item'], help: 'Show a product' },
      hide: { args: ['item'], help: 'Hide a product' },
      style: {
        args: ['item', 'fields'],
        help: 'Restyle a DEM or orthophoto: brightness=, contrast=, gamma=, or a DEM style field',
      },
    },
  },
  {
    noun: 'layer',
    list: 'layers',
    needs: ['project'],
    actions: {
      rename: { args: ['item', 'name'], help: 'Rename a vector layer (footprints, polygons, lines)' },
      remove: { args: ['item'], help: 'Remove a vector layer' },
      show: { args: ['item'], help: 'Show a vector layer on the map' },
      hide: { args: ['item'], help: 'Hide a vector layer on the map' },
    },
  },
  {
    noun: 'gcp',
    list: 'gcps',
    needs: ['project'],
    actions: {
      add: {
        args: ['name', 'choice?'],
        options: ['control', 'check', 'marker'],
        help: 'Add a GCP (control, the default), a checkpoint (check) or a marker',
      },
      set: {
        args: ['item', 'fields'],
        help:
          'Set a GCP: x=, y=, z= (no value clears it), accuracy= a preset (rtk-fixed, rtk-float, ' +
          'total-station, map-picked, unknown), datum= (ellipsoidal, geoid:EGM2008, geoid:EGM96, orthometric, local, unknown)',
      },
      role: {
        args: ['item', 'choice'],
        options: ['control', 'check', 'marker'],
        help: 'Make a GCP a control point, a checkpoint or a marker',
      },
      enable: { args: ['items'], help: 'Use GCPs again' },
      disable: { args: ['items'], help: 'Leave GCPs out of the solution' },
      remove: { args: ['items'], help: 'Remove GCPs and their marks' },
    },
  },
  {
    noun: 'scalebar',
    list: 'scalebars',
    needs: ['project'],
    actions: {
      add: {
        args: ['gcp', 'gcp', 'number', 'choice?'],
        options: ['m', 'cm', 'mm', 'ft', 'in'],
        help: 'Add a scale bar between two markers or GCPs: its length, in m unless a unit follows',
      },
      enable: { args: ['items'], help: 'Use scale bars in the fit again' },
      disable: { args: ['items'], help: 'Leave scale bars out of the fit' },
      remove: { args: ['items'], help: 'Remove scale bars' },
    },
  },
  {
    noun: 'matches',
    needs: ['matches'],
    actions: {
      remove: { args: [], help: 'Remove every match pair (the sparse models stay)' },
    },
  },
  {
    noun: 'region',
    needs: ['sparse'],
    actions: {
      set: {
        args: ['numbers6'],
        help: 'Set the region box in model coordinates: min x y z, then max x y z',
      },
      clear: { args: [], help: 'Clear the region: every step uses the whole model again' },
    },
  },
  {
    noun: 'orientation',
    needs: ['sparse'],
    actions: {
      clear: { args: [], help: 'Remove the orientation set by Orient: the frame levels from the cameras again' },
    },
  },
  {
    noun: 'template',
    list: 'workflows',
    needs: ['project'],
    actions: {
      save: { args: ['item'], help: 'Save a workflow as a template, for other projects' },
    },
  },
]

// The lists a name may come from, as the user calls their items.
export const LIST_NOUNS = {
  images: 'image',
  groups: 'image group',
  sensors: 'sensor',
  products: 'product',
  layers: 'layer',
  gcps: 'GCP',
  scalebars: 'scale bar',
  workflows: 'workflow',
}

const typed = (kind) => kind.replace(/\?$/, '')
const ARG_LABELS = {
  item: (e) => `<${LIST_NOUNS[e.list]}>`,
  items: (e) => `<${LIST_NOUNS[e.list]}> …`,
  images: () => '<image> …',
  gcp: () => '<GCP>',
  name: () => '<new name>',
  number: () => '<number>',
  numbers6: () => '<x0> <y0> <z0> <x1> <y1> <z1>',
  choice: (e, a) => a.options.join('|'),
  fields: () => '<key>=<value> …',
}

/** The usage line of one edit command. */
export function editUsage(edit, action) {
  const a = edit.actions[action]
  const parts = a.args.map((k) => {
    const label = ARG_LABELS[typed(k)](edit, a)
    return k.endsWith('?') ? `[${label}]` : label
  })
  return [`${edit.noun} ${action}`, ...parts].join(' ')
}

/** Quote an argument when it has a space or a quote, so splitArgs gives it back whole. */
export function quoteArg(value) {
  const s = String(value)
  if (s && !/[\s"']/.test(s)) return s
  return s.includes('"') ? `'${s}'` : `"${s}"`
}

const MAX_LISTED = 8

/**
 * The console command for an edit, as an Activity line names it:
 * editCommand('gcp disable', ['GCP 3']) → 'gcp disable "GCP 3"'. A long list of names
 * ends in "…": it says which command, not every name.
 */
export function editCommand(command, args = []) {
  const flat = args.flat().filter((a) => a != null && a !== '')
  const shown = flat.slice(0, MAX_LISTED).map(quoteArg)
  return [command, ...shown, ...(flat.length > MAX_LISTED ? ['…'] : [])].join(' ')
}

/**
 * An object by name: exact (any case), else the one name starting with it, else the
 * one containing it. → { item } | { error }.
 */
export function findNamed(items, query, noun = 'item') {
  const q = String(query ?? '')
    .trim()
    .toLowerCase()
  if (!q) return { error: `Give a ${noun} name` }
  const exact = items.filter((i) => String(i.name).toLowerCase() === q)
  if (exact.length === 1) return { item: exact[0] }
  if (exact.length > 1) return { error: `${exact.length} of the ${noun}s are named "${query}"` }
  for (const match of [(n) => n.startsWith(q), (n) => n.includes(q)]) {
    const hits = items.filter((i) => match(String(i.name).toLowerCase()))
    if (hits.length === 1) return { item: hits[0] }
    if (hits.length > 1) {
      return {
        error: `"${query}" matches ${hits.length} ${noun}s: ${hits
          .slice(0, 5)
          .map((i) => i.name)
          .join(', ')}${hits.length > 5 ? ', …' : ''}`,
      }
    }
  }
  return { error: `No ${noun} named "${query}"` }
}

// A key=value value: a number, true/false, an empty value (clears), else the text.
function fieldValue(raw) {
  if (raw === '') return ''
  if (/^(true|false)$/i.test(raw)) return raw.toLowerCase() === 'true'
  const n = Number(raw)
  return Number.isFinite(n) ? n : raw
}

/**
 * Read the arguments of an edit command. `lists(list)` gives the items a name may be
 * ({ id, name }). → { args } (in the table's order: an item, a list of items, a name,
 * a number, six numbers, a choice, a fields object) | { error }.
 */
export function parseEditArgs(edit, action, tokens, lists) {
  const spec = edit.actions[action]
  const out = []
  let i = 0
  const named = (list, query) => findNamed(lists(list) ?? [], query, LIST_NOUNS[list])
  for (let k = 0; k < spec.args.length; k++) {
    const kind = typed(spec.args[k])
    const optional = spec.args[k].endsWith('?')
    const last = k === spec.args.length - 1
    if (i >= tokens.length && kind !== 'fields') {
      if (optional) {
        out.push(kind === 'images' ? [] : null)
        continue
      }
      return { error: 'usage' }
    }
    if (kind === 'item' || kind === 'gcp') {
      const r = named(kind === 'gcp' ? 'gcps' : edit.list, tokens[i++])
      if (r.error) return r
      out.push(r.item)
    } else if (kind === 'items' || kind === 'images') {
      // The rest of the line, or all but what the following arguments take.
      const end = last ? tokens.length : tokens.length - (spec.args.length - 1 - k)
      const found = []
      for (; i < end; i++) {
        const r = named(kind === 'images' ? 'images' : edit.list, tokens[i])
        if (r.error) return r
        if (!found.includes(r.item)) found.push(r.item)
      }
      if (!found.length && !optional) return { error: 'usage' }
      out.push(found)
    } else if (kind === 'name') {
      const v = tokens[i++].trim()
      if (!v) return { error: 'usage' }
      out.push(v)
    } else if (kind === 'number' || kind === 'numbers6') {
      const n = kind === 'number' ? 1 : 6
      const nums = tokens.slice(i, i + n).map(Number)
      if (nums.length < n || nums.some((x) => !Number.isFinite(x)))
        return { error: `Give ${n === 1 ? 'a number' : `${n} numbers`}` }
      i += n
      out.push(n === 1 ? nums[0] : nums)
    } else if (kind === 'choice') {
      const v = tokens[i++].toLowerCase()
      if (!spec.options.includes(v)) return { error: `"${v}" is not one of ${spec.options.join(', ')}` }
      out.push(v)
    } else if (kind === 'fields') {
      const fields = {}
      for (; i < tokens.length; i++) {
        const m = tokens[i].match(/^([A-Za-z][\w.]*)=(.*)$/)
        if (!m) return { error: `"${tokens[i]}" is not key=value` }
        fields[m[1]] = fieldValue(m[2])
      }
      if (!Object.keys(fields).length) return { error: 'usage' }
      out.push(fields)
    }
  }
  if (i < tokens.length) return { error: `Too many arguments: ${tokens.slice(i).join(' ')}` }
  return { args: out }
}
