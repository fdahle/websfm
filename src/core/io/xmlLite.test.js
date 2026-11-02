import { describe, it, expect } from 'vitest'
import { parseXml, child, childrenOf, childNumber, numberList } from './xmlLite.js'

describe('parseXml', () => {
  it('reads elements, attributes, text and entities, and skips the prolog and comments', () => {
    const root = parseXml(`<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<document version="2.0.0">
  <chunk label="A &amp; B" enabled='true'>
    <f>1776.9</f>
    <empty/>
    <note><![CDATA[x < y]]></note>
    <name>caf&#233; &lt;1&gt;</name>
  </chunk>
</document>`)
    expect(root.name).toBe('document')
    expect(root.attrs.version).toBe('2.0.0')
    const chunk = child(root, 'chunk')
    expect(chunk.attrs).toEqual({ label: 'A & B', enabled: 'true' })
    expect(childNumber(chunk, 'f')).toBe(1776.9)
    expect(child(chunk, 'empty')).toMatchObject({ name: 'empty', text: '', children: [] })
    expect(child(chunk, 'note').text).toBe('x < y')
    expect(child(chunk, 'name').text).toBe('café <1>')
    expect(childNumber(chunk, 'missing')).toBeNull()
  })

  it('lists repeated children and number lists', () => {
    const root = parseXml('<a><b id="0"/><c/><b id="1">1 2\n 3.5e-1</b></a>')
    expect(childrenOf(root, 'b').map((b) => b.attrs.id)).toEqual(['0', '1'])
    expect(numberList(childrenOf(root, 'b')[1].text)).toEqual([1, 2, 0.35])
  })

  it('refuses a mismatched or unclosed tag', () => {
    expect(() => parseXml('<a><b></a>')).toThrow(/does not close/)
    expect(() => parseXml('<a><b>')).toThrow(/not closed/)
    expect(() => parseXml('just text')).toThrow(/no root/)
  })
})
