import { describe, expect, it } from 'vitest'
import { runTabTitle, stageNotice, workflowNotice, stageErrorToast } from './runAttention.js'

const base = 'websfm — photogrammetry in your browser'

describe('runTabTitle', () => {
  it('shows the stage and its percent, capped at 99', () => {
    expect(runTabTitle(base, { run: { title: 'Building Depth Maps', percent: 43 } }))
      .toBe(`43% · Building Depth Maps · ${base}`)
    expect(runTabTitle(base, { run: { title: 'Building DEM', percent: 100 } })).toMatch(/^99% · /)
  })
  it('leaves out the percent of an indeterminate stage', () => {
    expect(runTabTitle(base, { run: { title: 'Building DEM', percent: 0, indeterminate: true } }))
      .toBe(`Building DEM · ${base}`)
  })
  it('says a paused workflow is waiting, and restores the base when idle', () => {
    expect(runTabTitle(base, { waiting: true })).toBe(`Waiting for you · ${base}`)
    expect(runTabTitle(base)).toBe(base)
  })
})

describe('stageNotice', () => {
  const run = (over = {}) => ({ title: 'Building Mesh', ok: true, cancelled: false, startedAt: 0, endedAt: 95_000, ...over })
  it('stays quiet for a short run', () => {
    expect(stageNotice(run({ endedAt: 20_000 }))).toBeNull()
  })
  it('reports finished, cancelled and failed runs', () => {
    expect(stageNotice(run())).toEqual({ title: 'Building Mesh finished', body: 'after 1:35' })
    expect(stageNotice(run({ cancelled: true })).title).toBe('Building Mesh cancelled')
    expect(stageNotice(run(), ['Mesh error: out of memory'])).toEqual({ title: 'Building Mesh failed', body: 'Mesh error: out of memory' })
    expect(stageNotice(run({ ok: false })).title).toBe('Building Mesh failed')
  })
})

describe('workflowNotice', () => {
  const at = (s) => new Date(Date.UTC(2026, 9, 19, 12, 0, s)).toISOString()
  it('names the workflow and its outcome', () => {
    expect(workflowNotice({ name: 'Aerial', outcome: 'completed', startedAt: at(0), finishedAt: at(45) }))
      .toEqual({ title: 'Workflow “Aerial” finished', body: 'after 0:45' })
    expect(workflowNotice({ name: 'Aerial', outcome: 'failed', error: 'Sparse failed', startedAt: at(0), finishedAt: at(45) }).body)
      .toBe('Sparse failed')
    expect(workflowNotice({ name: 'Aerial', outcome: 'completed', startedAt: at(0), finishedAt: at(5) })).toBeNull()
  })
})

describe('stageErrorToast', () => {
  const run = { title: 'Detecting Features', ok: true, cancelled: false, startedAt: 0, endedAt: 1 }
  it('counts the errors and shows the first', () => {
    expect(stageErrorToast(run, ['a', 'b', 'c'])).toEqual({ title: 'Detecting Features: 3 errors', detail: 'a' })
    expect(stageErrorToast(run, ['a']).title).toBe('Detecting Features: an error')
  })
  it('stays quiet without errors or after a cancel', () => {
    expect(stageErrorToast(run, [])).toBeNull()
    expect(stageErrorToast({ ...run, cancelled: true }, ['reconstruction cancelled'])).toBeNull()
  })
})
