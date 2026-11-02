// A small XML reader for the interchange files WebSfM imports (Metashape cameras and
// markers). Core code has no DOMParser (it runs in workers and the Node tests), and
// these files are plain data: elements, attributes and text, no DTDs or namespaces
// that matter. Pure.
//
// parseXml(text) → the root element { name, attrs, children, text }, where `children`
// are elements only and `text` is the element's own character data, trimmed and with
// the five predefined entities and numeric references decoded. Comments, the XML
// declaration, processing instructions and DOCTYPE are skipped; CDATA is text.
// Throws on a closing tag that does not match, or on input with no root element.

const ENTITIES = { lt: '<', gt: '>', amp: '&', apos: "'", quot: '"' }

export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#')
      return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    return ENTITIES[e] ?? m
  })
}

const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g

export function parseXml(text) {
  const src = String(text)
  const stack = [{ name: '#document', attrs: {}, children: [], parts: [] }]
  let i = 0
  while (i < src.length) {
    const lt = src.indexOf('<', i)
    const top = stack[stack.length - 1]
    if (lt < 0) {
      top.parts.push(src.slice(i))
      break
    }
    if (lt > i) top.parts.push(src.slice(i, lt))
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt + 4)
      i = end < 0 ? src.length : end + 3
    } else if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt + 9)
      top.parts.push({ cdata: src.slice(lt + 9, end < 0 ? src.length : end) })
      i = end < 0 ? src.length : end + 3
    } else if (src[lt + 1] === '?' || src[lt + 1] === '!') {
      const end = src.indexOf('>', lt)
      i = end < 0 ? src.length : end + 1
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt)
      const name = src.slice(lt + 2, end).trim()
      const el = stack.pop()
      if (stack.length === 0 || el.name !== name) throw new Error(`XML: </${name}> does not close <${el.name}>`)
      finish(el)
      i = end + 1
    } else {
      const end = src.indexOf('>', lt)
      if (end < 0) throw new Error('XML: unterminated tag')
      const selfClosing = src[end - 1] === '/'
      const body = src.slice(lt + 1, selfClosing ? end - 1 : end)
      const name = body.match(/^[^\s/>]+/)?.[0]
      if (!name) throw new Error('XML: tag without a name')
      const attrs = {}
      for (const m of body.slice(name.length).matchAll(ATTR)) attrs[m[1]] = decodeEntities(m[3] ?? m[4])
      const el = { name, attrs, children: [], parts: [] }
      top.children.push(el)
      if (selfClosing) finish(el)
      else stack.push(el)
      i = end + 1
    }
  }
  if (stack.length !== 1) throw new Error(`XML: <${stack[stack.length - 1].name}> is not closed`)
  const root = stack[0].children[0]
  if (!root) throw new Error('XML: no root element')
  return root
}

function finish(el) {
  el.text = el.parts
    .map((p) => (typeof p === 'string' ? decodeEntities(p) : p.cdata))
    .join('')
    .trim()
  delete el.parts
}

// The first child element called `name`, or null.
export const child = (el, name) => el?.children.find((c) => c.name === name) ?? null

// Every child element called `name`.
export const childrenOf = (el, name) => el?.children.filter((c) => c.name === name) ?? []

// The text of the first child called `name` as a number, or null.
export function childNumber(el, name) {
  const t = child(el, name)?.text
  if (t == null || t === '') return null
  const v = Number(t)
  return Number.isFinite(v) ? v : null
}

// Whitespace-separated numbers (a matrix or vector element's text).
export const numberList = (text) =>
  String(text ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
