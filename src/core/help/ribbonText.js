// The ribbon's words as catalogue entries (core/i18n). The tables stay the English
// source, readable where the commands are defined: ribbonTabs.js (labels, tips, menu
// blurbs, sections, groups, tabs) and commands.js (the prerequisite reasons). This turns
// them into keys,
//   ribbon.cmd.<id>.label | tip | blurb | countLabel   a command; a reused entry that
//                                                      relabels itself names a `labelId`
//   ribbon.section.<slug> · ribbon.group.<slug> · ribbon.tab.<slug>   by their English
//   ribbon.need.<NEED_CHECKS key> · ribbon.reason.comingSoon | aerialOnly
// so another language words the ribbon in core/i18n/<lang>/ribbon.js and the unit tests
// check it like any other message. Pure, and no import of core/i18n: the English
// catalogue imports this.
import { allGroups, TABS, PICTURE_TAB, rasterTab } from './ribbonTabs.js'
import { NEED_CHECKS, AERIAL_ONLY_REASON } from './commands.js'

/** 'DEM / orthophoto in front' → 'demOrthophotoInFront'; 'Geo-\nreference' → 'georeference'. */
export function slug(text) {
  const words = String(text)
    .replace(/-\n/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  return words.map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('')
}

/** The catalogue key of a command's `field`: its id's, the label under `labelId` if it has one. */
export const cmdKey = (cmd, field) => `ribbon.cmd.${(field === 'label' && cmd.labelId) || cmd.id}.${field}`

const CMD_FIELDS = ['label', 'tip', 'blurb', 'countLabel']

/**
 * → { catalogue, conflicts }: the English entries, and every key the tables give two
 * different texts (a reused entry relabelled without its own `labelId`); a test keeps
 * that list empty.
 */
export function ribbonCatalogue() {
  const cat = {
    cmd: {},
    section: {},
    group: {},
    tab: {},
    need: {},
    reason: { comingSoon: 'Coming soon', aerialOnly: AERIAL_ONLY_REASON },
  }
  const conflicts = []
  const put = (obj, key, text, where) => {
    if (text == null || text === '') return
    if (key in obj && obj[key] !== text) conflicts.push(`${where}: "${obj[key]}" / "${text}"`)
    else obj[key] = text
  }
  const putCmd = (c) => {
    if (!c.id) return
    for (const f of CMD_FIELDS) {
      const id = cmdKey(c, f).split('.')[2]
      put((cat.cmd[id] ??= {}), f, c[f], `cmd ${id}.${f}`)
    }
  }
  for (const g of allGroups()) {
    put(cat.group, slug(g.label), g.label, `group ${g.label}`)
    for (const c of g.commands) {
      if (c.pair) c.pair.forEach(putCmd)
      else if (c.menu) {
        putCmd(c)
        for (const row of c.menu) {
          if (row.section) put(cat.section, slug(row.section), row.section, `section ${row.section}`)
          else putCmd(row)
        }
      } else putCmd(c)
    }
  }
  for (const t of [...TABS, PICTURE_TAB, rasterTab({ kind: 'dem' }), rasterTab({ kind: 'ortho' })])
    put(cat.tab, slug(t.label), t.label, `tab ${t.label}`)
  for (const [k, check] of Object.entries(NEED_CHECKS)) put(cat.need, k, check.reason, `need ${k}`)
  for (const k of Object.keys(cat.cmd)) if (!Object.keys(cat.cmd[k]).length) delete cat.cmd[k]
  return { catalogue: cat, conflicts }
}
