import { describe, it, expect, beforeEach } from 'vitest'
import {
  tuningOverrides,
  setTuningOverride,
  editFlag,
  resetAllFlags,
  setKeepFlags,
  restoreKeptFlags,
  logFlagsOnOpen,
  applyTuningOverrides,
  changedFlags,
  flagCount,
  keepFlags,
  _resetFlagsForTests,
} from './tuningOverrides.js'
import { useLog } from '../composables/useLog.js'
import { SFM_TUNING } from '../core/tuning.js'

// An in-memory stand-in for localStorage.
function memoryStorage(initial = {}) {
  const data = { ...initial }
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => {
      data[k] = String(v)
    },
    removeItem: (k) => {
      delete data[k]
    },
  }
}

const KEY = 'websfm.flags.v1'

beforeEach(() => {
  _resetFlagsForTests()
  globalThis.localStorage = memoryStorage()
})

describe('flags store', () => {
  it('holds the overrides for the session, and runs merge and log them', () => {
    setTuningOverride('sfm', ['minPnpInlierRatio'], 0.5)
    expect(flagCount.value).toBe(1)
    expect(changedFlags.value).toEqual([
      { key: 'sfm.minPnpInlierRatio', group: 'sfm', value: 0.5, def: SFM_TUNING.minPnpInlierRatio },
    ])
    const heard = []
    const s = applyTuningOverrides('sfm', { minPnpInlierRatio: 0.3, x: 1 }, (m) => heard.push(m))
    expect(s).toEqual({ minPnpInlierRatio: 0.5, x: 1 })
    expect(heard).toEqual(['Changed flags in effect (sfm): minPnpInlierRatio=0.5'])
    expect(applyTuningOverrides('match', { a: 1 }, (m) => heard.push(m))).toEqual({ a: 1 })
    expect(heard).toHaveLength(1)
    // Session only: nothing is written to the browser's storage.
    expect(globalThis.localStorage.data).toEqual({})
  })

  it('confirms a hand edit on the Activity channel with the console command', () => {
    const { entries } = useLog()
    editFlag('sfm', ['baSolver', 'direct'], 'implicit')
    let line = entries.value.at(-1)
    expect(line).toMatchObject({
      level: 'info',
      source: 'Sparse',
      channel: 'activity',
      command: 'set sfm.baSolver.direct implicit',
    })
    expect(line.message).toBe('Flag sfm.baSolver.direct: true → "implicit" (default true)')
    editFlag('sfm', ['baSolver', 'direct'], undefined)
    line = entries.value.at(-1)
    expect(line.command).toBe('set sfm.baSolver.direct default')
    expect(tuningOverrides('sfm')).toEqual({})
    editFlag('match', ['lgMinConf'], 0.2)
    editFlag('sfm', ['rescueStalled'], false)
    resetAllFlags()
    line = entries.value.at(-1)
    expect(line).toMatchObject({ channel: 'activity', command: 'set default' })
    expect(line.message).toBe('Flags reset to their defaults: sfm.rescueStalled, match.lgMinConf')
    expect(flagCount.value).toBe(0)
  })

  it('keeps the flags in this browser only with Keep after reload, and forgets them when turned off', () => {
    setTuningOverride('sfm', ['minPnpInlierRatio'], 0.5)
    setKeepFlags(true)
    expect(JSON.parse(globalThis.localStorage.data[KEY])).toEqual({
      keep: true,
      overrides: { sfm: { minPnpInlierRatio: 0.5 } },
    })
    setTuningOverride('match', ['lgMinConf'], 0.1)
    expect(JSON.parse(globalThis.localStorage.data[KEY]).overrides.match).toEqual({ lgMinConf: 0.1 })
    setKeepFlags(false)
    expect(globalThis.localStorage.data).toEqual({})
    expect(flagCount.value).toBe(2) // still in effect for this session
  })

  it('restores kept flags at start, and logs what it dropped and what is in effect as a project opens', () => {
    const storage = memoryStorage({
      [KEY]: JSON.stringify({
        keep: true,
        overrides: { sfm: { minPnpInlierRatio: 0.5, rescueStalled: 3, goneKnob: 1 } },
      }),
    })
    restoreKeptFlags({ storage })
    expect(keepFlags.value).toBe(true)
    expect(tuningOverrides('sfm')).toEqual({ minPnpInlierRatio: 0.5 })
    // What was dropped is gone from storage too.
    expect(JSON.parse(storage.data[KEY]).overrides).toEqual({ sfm: { minPnpInlierRatio: 0.5 } })
    const lines = []
    const log = (m, level, source) => lines.push([level, source, m])
    logFlagsOnOpen(log)
    expect(lines.map((l) => l.slice(0, 2))).toEqual([
      ['warn', 'System'],
      ['warn', 'System'],
      ['warn', 'System'],
    ])
    expect(lines[0][2]).toMatch(/^Kept flag sfm.rescueStalled dropped: the value no longer fits/)
    expect(lines[1][2]).toMatch(/^Kept flag sfm.goneKnob dropped: no longer an internal tuning value/)
    expect(lines[2][2]).toBe(
      'Changed flags in effect (Other ▸ Debug ▸ Flags, kept in this browser): sfm.minPnpInlierRatio=0.5',
    )
    // The next project's log hears only what is in effect; nothing once all are reset.
    lines.length = 0
    logFlagsOnOpen(log)
    expect(lines).toHaveLength(1)
    resetAllFlags()
    lines.length = 0
    logFlagsOnOpen(log)
    expect(lines).toEqual([])
  })

  it('starts empty from storage that is missing, unreadable or throws', () => {
    restoreKeptFlags({ storage: memoryStorage() })
    restoreKeptFlags({ storage: memoryStorage({ [KEY]: '{not json' }) })
    restoreKeptFlags({
      storage: {
        getItem() {
          throw new Error('blocked')
        },
      },
    })
    restoreKeptFlags({ storage: undefined })
    expect(flagCount.value).toBe(0)
    expect(keepFlags.value).toBe(false)
    globalThis.localStorage = {
      setItem() {
        throw new Error('full')
      },
      removeItem() {
        throw new Error('blocked')
      },
    }
    expect(() => setKeepFlags(true)).not.toThrow()
    expect(() => setTuningOverride('sfm', ['minPnpInlierRatio'], 0.4)).not.toThrow()
    expect(flagCount.value).toBe(1)
  })
})
