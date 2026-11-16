// Write docs/features.md from the ribbon tables and the guide articles
// (src/core/help/features.js says what goes in it).
//
//   npm run docs:features
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseGuideDoc } from '../src/core/help/guide.js'
import { ribbonEntries } from '../src/core/help/ribbonTabs.js'
import { featuresMarkdown } from '../src/core/help/features.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const guideDir = `${root}src/guide/`
const guides = new Map()
for (const file of readdirSync(guideDir).filter((f) => f.endsWith('.md'))) {
  const doc = parseGuideDoc(readFileSync(guideDir + file, 'utf8'), file)
  guides.set(doc.id, doc)
}
const out = `${root}docs/features.md`
writeFileSync(out, featuresMarkdown(ribbonEntries(), guides))
console.log(`Wrote docs/features.md: ${ribbonEntries().length} commands, ${guides.size} guide articles`)
