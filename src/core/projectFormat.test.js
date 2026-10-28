import { describe, it, expect } from 'vitest'
import { PROJECT_FORMAT_VERSION, projectFormatOf, projectFormatProblem } from './projectFormat.js'

describe('projectFormat', () => {
  it('counts a project without a version as format 1', () => {
    expect(projectFormatOf({ name: 'old' })).toBe(1)
    expect(projectFormatProblem({ name: 'old' })).toBeNull()
  })

  it('opens the current format', () => {
    expect(projectFormatProblem({ formatVersion: PROJECT_FORMAT_VERSION })).toBeNull()
  })

  it('refuses a newer format with a reload hint', () => {
    expect(projectFormatProblem({ formatVersion: PROJECT_FORMAT_VERSION + 1 })).toMatch(/newer version.*Reload/)
  })

  it('refuses an invalid version', () => {
    expect(projectFormatOf({ formatVersion: 'x' })).toBeNull()
    expect(projectFormatProblem({ formatVersion: 0 })).toMatch(/invalid format version/)
  })
})
