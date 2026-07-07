import { describe, it, expect } from 'vitest'

import {
  COMMANDS,
  tokenize,
  resolveCommand,
  getCommand,
  guardReason,
  completions,
  commonPrefix,
  helpLines,
  helpFor,
} from './commands.js'

// A state where every prerequisite is satisfied — start here and knock one out.
const READY = {
  imageCount: 5, kpImageCount: 5, matchCount: 10, sparseReady: true,
  depthMapCount: 5, cloudReady: true, demReady: true, orthoReady: true,
  productReady: true, gcpCount: 3, poseCount: 5, sensorCount: 1,
}

describe('tokenize', () => {
  it('splits on whitespace and drops empties', () => {
    expect(tokenize('  export   cloud  ')).toEqual(['export', 'cloud'])
    expect(tokenize('')).toEqual([])
    expect(tokenize(null)).toEqual([])
  })
})

describe('resolveCommand', () => {
  it('resolves a single-token command', () => {
    const r = resolveCommand('dense')
    expect(r.cmd?.dispatch).toBe('dense')
    expect(r.args).toEqual([])
  })

  it('is case-insensitive and resolves aliases', () => {
    expect(resolveCommand('RECONSTRUCT').cmd?.dispatch).toBe('reconstruct')
    expect(resolveCommand('georef').cmd?.dispatch).toBe('auto-georeference')
  })

  it('prefers the 2-token name over the bare first token', () => {
    const r = resolveCommand('export cloud extra')
    expect(r.cmd?.dispatch).toBe('export-cloud')
    expect(r.name).toBe('export cloud')
    expect(r.args).toEqual(['extra'])
  })

  it('flags empty input', () => {
    expect(resolveCommand('   ').error).toBe('empty')
  })

  it('flags unknown commands with suggestions', () => {
    const r = resolveCommand('densee')
    expect(r.error).toBe('unknown')
    expect(r.suggestions).toContain('dense')
  })
})

describe('guardReason', () => {
  it('returns empty when all prerequisites are met', () => {
    expect(guardReason(['depthMaps'], READY)).toBe('')
  })

  it('returns the first unmet prerequisite message', () => {
    expect(guardReason(['depthMaps'], { ...READY, depthMapCount: 0 }))
      .toBe('Compute depth maps first')
    expect(guardReason(['dem', 'depthMaps'], { ...READY, demReady: false, depthMapCount: 0 }))
      .toBe('Build a DEM first')
  })

  it('treats missing state fields as unmet', () => {
    expect(guardReason(['images'], {})).toBe('Import images first')
  })

  it('is a no-op for commands with no needs', () => {
    expect(guardReason(undefined, {})).toBe('')
    expect(guardReason([], {})).toBe('')
  })
})

describe('completions', () => {
  it('returns invocations sharing the prefix, sorted', () => {
    const c = completions('de')
    expect(c).toContain('dense')
    expect(c).toContain('detect')
    expect([...c]).toEqual([...c].sort())
  })

  it('completes multi-word export subcommands', () => {
    expect(completions('export c')).toEqual(
      expect.arrayContaining(['export cameras', 'export cloud']),
    )
  })
})

describe('commonPrefix', () => {
  it('finds the longest shared prefix', () => {
    expect(commonPrefix(['export cloud', 'export cameras'])).toBe('export c')
    expect(commonPrefix(['dense', 'detect'])).toBe('de')
    expect(commonPrefix(['map', 'viewer'])).toBe('')
    expect(commonPrefix([])).toBe('')
  })
})

describe('help', () => {
  it('lists every command under a group header', () => {
    const lines = helpLines()
    for (const cmd of COMMANDS) {
      expect(lines.some((l) => l.includes(cmd.name))).toBe(true)
    }
    expect(lines.some((l) => l.startsWith('— '))).toBe(true)
  })

  it('gives per-command detail including requirements', () => {
    const lines = helpFor('ortho')
    expect(lines[0]).toContain('ortho')
    expect(lines.join('\n')).toContain('requires: dem, depthMaps')
    expect(helpFor('nope')).toBeNull()
  })
})

describe('registry integrity', () => {
  it('has unique names and no alias/name collisions', () => {
    const seen = new Set()
    for (const cmd of COMMANDS) {
      for (const key of [cmd.name, ...(cmd.aliases ?? [])]) {
        const k = key.toLowerCase()
        expect(seen.has(k), `duplicate command key: ${k}`).toBe(false)
        seen.add(k)
      }
    }
  })

  it('every command has a dispatch id and getCommand round-trips', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.dispatch, `${cmd.name} missing dispatch`).toBeTruthy()
      expect(getCommand(cmd.name)).toBe(cmd)
    }
  })
})
