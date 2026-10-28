#!/usr/bin/env node
// The GitHub release notes of one version, from CHANGELOG.md: its section as written,
// then a link to the app. CI's deploy job runs it for a pushed v* tag
// (.github/workflows/verify.yml) and makes the release from its output.
//
//   node scripts/release-notes.mjs 0.5.0 > notes.md
import { readFile } from 'node:fs/promises'
import { releaseSection } from '../src/core/help/changelog.js'

const version = process.argv[2]?.replace(/^v/, '')
if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version>')
  process.exit(2)
}
const md = await readFile(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const section = releaseSection(md, version)
if (!section) {
  console.error(`release-notes: CHANGELOG.md has no section for ${version}`)
  process.exit(1)
}
process.stdout.write(`${section}\n\n---\n\nTry it at **[websfm.app](https://websfm.app)**, nothing to install.\n`)
