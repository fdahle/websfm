import { describe, it, expect } from 'vitest'
import { PROJECT_FORMAT_VERSION, projectFormatOf, projectFormatProblem, stampNewestVersion } from './projectFormat.js'

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

  it('refuses a project a newer WebSfM opened, even in the same format', () => {
    const data = { formatVersion: PROJECT_FORMAT_VERSION, newestAppVersion: '0.10.0' }
    // 0.10.0 > 0.9.0 by number, not by text.
    expect(projectFormatProblem(data, { appVersion: '0.9.0' })).toMatch(/opened in WebSfM 0\.10\.0.*Reload/)
    // A pinned copy points to the newest version instead of a reload, which would not help.
    const pinned = projectFormatProblem(data, { appVersion: '0.9.0', pinned: true })
    expect(pinned).toMatch(/newest version/)
    expect(pinned).not.toMatch(/Reload/)
    // The same or an older version opened it: fine, and so is a project without the field.
    expect(projectFormatProblem(data, { appVersion: '0.10.0' })).toBeNull()
    expect(projectFormatProblem(data, { appVersion: '0.11.0' })).toBeNull()
    expect(projectFormatProblem({ formatVersion: PROJECT_FORMAT_VERSION }, { appVersion: '0.9.0' })).toBeNull()
    // A pre-release comes before its release.
    expect(projectFormatProblem({ newestAppVersion: '1.0.0' }, { appVersion: '1.0.0-beta.1' })).toMatch(/newer/)
  })

  it('stamps the newest version that opened a project, never lowering it', () => {
    expect(stampNewestVersion({ name: 'p' }, '0.9.0')).toEqual({ name: 'p', newestAppVersion: '0.9.0' })
    expect(stampNewestVersion({ newestAppVersion: '0.9.0' }, '0.10.0')).toEqual({ newestAppVersion: '0.10.0' })
    expect(stampNewestVersion({ newestAppVersion: '0.10.0' }, '0.10.0')).toBeNull()
    expect(stampNewestVersion({ newestAppVersion: '0.10.0' }, '0.9.0')).toBeNull()
    // A value that is not a version is replaced.
    expect(stampNewestVersion({ newestAppVersion: 'junk' }, '0.9.0')).toEqual({ newestAppVersion: '0.9.0' })
  })
})
