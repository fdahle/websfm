// Each internal tuning knob's help, read from the comments above it in tuning.js, so the
// help Debug ▸ Flags shows is the code's own and cannot drift from it. The dialog passes
// the file's text (a Vite `?raw` import, loaded with the dialog); the parse is here, pure
// and unit-tested against the real file (tuningHelp.test.js checks that every knob the
// console can set gets help).
//
// What the parser reads, as tuning.js is written:
//   - `export const NAME = {` opens a group; the comment block right above it is the
//     group's introduction. Nested `key: {` opens a sub-group (sfm.baSolver).
//   - the `//` lines right above a `key:` line, and a comment after its value on the
//     same line, are that key's help. A key with neither shares the help of the key
//     before it at the same level (a comment written for a run of keys, such as the
//     three final-track gates; not across a section title), or else that of its
//     sub-group (baSolver's keys).
//   - `// ── Title ──` starts a section: the keys under it, to the next title, are
//     filed under it, and the title line is not part of anyone's help.
//   - a `// (…)` line right after a key with a same-line comment continues that comment.

const OPEN_GROUP = /^export const ([A-Z0-9_]+)\s*=\s*\{\s*$/
const KEY = /^\s*([A-Za-z_$][\w$]*)\s*:\s*(.*)$/
const SECTION = /^\s*\/\/\s*──\s*(.+?)\s*──\s*$/
const COMMENT = /^\s*\/\/ ?(.*)$/

// The text after a value on its line: `200, // max CG iterations` → 'max CG iterations'.
// A `//` inside a string literal (a URL) is not a comment.
function trailingComment(rest) {
  let quote = null
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"' || c === '`') quote = c
    else if (c === '/' && rest[i + 1] === '/') return rest.slice(i + 2).trim()
  }
  return ''
}

const joinLines = (lines) =>
  lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

/**
 * tuning.js text → { [EXPORT_NAME]: { intro, keys: { 'a' | 'a.b': { help, section, sharedWith } } } }.
 * `help` is plain text with its line breaks; `sharedWith` names the key (dotted, without
 * the group) whose comment it shares, or is null for a key's own comment.
 */
export function parseTuningHelp(source) {
  const out = {}
  const lines = String(source ?? '').split('\n')
  let pending = [] // comment lines waiting for the key (or group) below them
  let group = null // { name, keys, stack: [{ prefix, last, help }], section }
  let continueAfterTrailing = false

  for (const line of lines) {
    const trimmed = line.trim()
    if (!group) {
      const m = OPEN_GROUP.exec(trimmed)
      if (m) {
        group = { name: m[1], keys: {}, stack: [{ prefix: '', last: null, help: '' }], section: null }
        out[m[1]] = { intro: joinLines(pending.filter((l) => !SECTION.test(`//${l}`))), keys: group.keys }
        pending = []
      } else if (COMMENT.test(line)) pending.push(COMMENT.exec(line)[1])
      else pending = []
      continue
    }

    const level = group.stack[group.stack.length - 1]
    if (trimmed === '') {
      continueAfterTrailing = false
      continue
    }
    const section = SECTION.exec(line)
    if (section) {
      // A new section starts afresh: no key shares a comment across a title.
      if (group.stack.length === 1) {
        group.section = section[1]
        level.last = null
        level.lastHelp = ''
      }
      pending = []
      continueAfterTrailing = false
      continue
    }
    const comment = COMMENT.exec(line)
    if (comment) {
      const text = comment[1]
      if (continueAfterTrailing && /^\(.*\)$/.test(text.trim()) && level.last) {
        const k = group.keys[level.last]
        k.help = `${k.help} ${text.trim()}`
        level.lastHelp = k.help
      } else pending.push(text)
      continueAfterTrailing = false
      continue
    }
    if (/^\}[,;]?$/.test(trimmed)) {
      // A `}` in the first column closes the group, whatever was left open inside it.
      if (group.stack.length === 1 || !/^\s/.test(line)) group = null
      else group.stack.pop()
      pending = []
      continueAfterTrailing = false
      continue
    }
    const key = KEY.exec(line)
    if (!key) {
      pending = []
      continueAfterTrailing = false
      continue
    }
    const [, name, rest] = key
    const path = level.prefix ? `${level.prefix}.${name}` : name
    const trailing = trailingComment(rest)
    const own = joinLines([...pending, ...(trailing ? [trailing] : [])])
    pending = []
    let help = own
    let sharedWith = null
    if (!own) {
      if (level.last && level.lastHelp) {
        help = level.lastHelp
        sharedWith = group.keys[level.last].sharedWith ?? level.last
      } else if (level.help) {
        help = level.help
        sharedWith = level.prefix
      }
    }
    if (/^\{\s*(\/\/.*)?$/.test(rest.trim())) {
      // A sub-group: its comment is the help of the keys inside that have none.
      group.keys[path] = { help, section: group.section, sharedWith, group: true }
      level.last = path
      level.lastHelp = help
      group.stack.push({ prefix: path, last: null, lastHelp: '', help })
      continueAfterTrailing = false
      continue
    }
    group.keys[path] = { help, section: group.section, sharedWith }
    level.last = path
    level.lastHelp = help
    continueAfterTrailing = !!trailing
  }
  return out
}
