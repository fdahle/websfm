import { describe, it, expect } from 'vitest'
import { RUN_BLOCKS, RUN_STAGES, RUN_STAGE_NAMES, parseRunArgs, runStageHelp } from './consoleRun.js'
import { WORKFLOW_BLOCKS } from '../workflow.js'

describe('consoleRun', () => {
  it('takes every block a workflow runs unattended, and no control or interactive block', () => {
    const want = WORKFLOW_BLOCKS.filter((b) => b.automated && !b.control).map((b) => b.id)
    expect(RUN_BLOCKS.map((b) => b.id)).toEqual(want)
    expect(new Set(Object.values(RUN_STAGES))).toEqual(new Set(want))
    expect(RUN_STAGES.goto).toBeUndefined()
    expect(RUN_STAGES['auto-mask']).toBeUndefined()
    expect(RUN_STAGE_NAMES).toHaveLength(want.length)
  })

  it('types each value as its field says', () => {
    const { stages } = parseRunArgs(['filter', 'methods=sor,voxel', 'texture', 'maxScale=0.5', 'levelColours=off'])
    expect(stages[0].settings.methods).toEqual(['sor', 'voxel'])
    expect(stages[1].settings).toEqual({ maxScale: 0.5, levelColours: false })
  })

  it('lists a stage’s settings with their defaults', () => {
    const lines = runStageHelp('dem')
    expect(lines[0]).toMatch(/^run dem — /)
    expect(lines.some((l) => /^ {2}aggregate = median\|max\|mean\|min/.test(l))).toBe(true)
    expect(runStageHelp('nonsense')).toBeNull()
  })
})
