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
  consoleReason,
  ribbonCommandFor,
  AERIAL_ONLY_REASON,
  KEY_COLLISIONS,
  CONSOLE_NAMES,
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
    expect(resolveCommand('georef').cmd?.dispatch).toBe('georeference')
    expect(resolveCommand('find gcps').cmd?.dispatch).toBe('find-gcps')
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
  it('lists every command under a group header with "help all"', () => {
    const lines = helpLines('all')
    for (const cmd of COMMANDS) {
      expect(lines.some((l) => l.includes(cmd.name)), cmd.name).toBe(true)
    }
    expect(lines.some((l) => l.startsWith('— '))).toBe(true)
  })

  it('keeps the plain overview to the verbs and the named commands, and points at the rest', () => {
    const lines = helpLines()
    expect(lines.some((l) => l.startsWith('  run'))).toBe(true)
    expect(lines.some((l) => l.startsWith('  decimate'))).toBe(true)
    expect(lines.some((l) => l.startsWith('  raster zoom in'))).toBe(false)
    expect(lines.at(-1)).toMatch(/more ribbon commands: "help <tab>"/)
    expect(helpLines('tools').some((l) => l.startsWith('  crop mesh'))).toBe(true)
    expect(helpLines('nonsense')).toBeNull()
  })

  it('shows a verb\'s usage and a ribbon command\'s location', () => {
    expect(helpFor('set').join('\n')).toContain('usage: set <group>.<key> <value>')
    expect(helpFor('crop mesh').join('\n')).toContain('ribbon: Tools ▸ Mesh ▸ Crop…')
    expect(helpFor('point size').join('\n')).toContain('usage: point size <value>   (1 – 8)')
  })

  it('gives per-command detail including requirements', () => {
    const lines = helpFor('ortho')
    expect(lines[0]).toContain('ortho')
    // The ribbon's own prerequisites — the console never restates them.
    expect(lines.join('\n')).toContain('requires: imagesReady, depthMaps, surface')
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

  it('every command has a dispatch id or is a verb, and getCommand round-trips', () => {
    for (const cmd of COMMANDS) {
      expect(cmd.dispatch || cmd.verb, `${cmd.name} missing dispatch`).toBeTruthy()
      expect(getCommand(cmd.name)).toBe(cmd)
    }
    expect(KEY_COLLISIONS).toEqual([])
  })

  it('names only ribbon commands in the short-name table', () => {
    for (const id of Object.keys(CONSOLE_NAMES)) expect(ribbonCommandFor({ dispatch: id }), id).not.toBeNull()
  })

  it('derives commands from the ribbon: by id, by id as words, and new rows for free', () => {
    expect(resolveCommand('crop-mesh').cmd.dispatch).toBe('crop-mesh')
    expect(resolveCommand('crop mesh').cmd.dispatch).toBe('crop-mesh')
    expect(resolveCommand('export camera fiducials').cmd.dispatch).toBe('export-camera-fiducials')
    expect(resolveCommand('export measurements').cmd.dispatch).toBe('export-measurements')
    expect(resolveCommand('basemap satellite').cmd.dispatch).toBe('map-basemap:satellite')
    expect(resolveCommand('map toggle cameras').cmd.dispatch).toBe('map-toggle-cameras')
  })
})

describe('console ↔ ribbon parity', () => {
  it('takes every ribbon-backed command checks from the ribbon, never its own copy', () => {
    for (const cmd of COMMANDS) {
      if (ribbonCommandFor(cmd)) expect(cmd.needs, `${cmd.name} restates needs`).toBeUndefined()
    }
  })

  it('applies the ribbon prerequisites and aerial-only rule', () => {
    const match = getCommand('match')
    expect(consoleReason(match, { ...READY, imagesLoading: true })).toBe('Images still loading…')
    const dem = getCommand('dem')
    expect(consoleReason(dem, { ...READY, sceneType: 'object' })).toBe(AERIAL_ONLY_REASON)
    expect(consoleReason(dem, { ...READY, sceneType: 'aerial' })).toBe('')
  })

  it('routes the measuring words to the measuring tools', () => {
    expect(getCommand('profile').dispatch).toBe('measure-profile')
    expect(getCommand('volume').dispatch).toBe('measure-volume')
    expect(getCommand('section').dispatch).toBe('cloud-section')
    expect(consoleReason(getCommand('ruler'), { ...READY, frontView: 'viewer' }))
      .toBe('Open a DEM or orthophoto, or show one on the map')
    expect(consoleReason(getCommand('ruler'), { ...READY, frontView: 'raster' })).toBe('')
  })
})
