import { describe, it, expect } from 'vitest'
import {
  PROJECT_ARCHIVE_VERSION, ARCHIVE_DERIVED_DIRS,
  shouldArchivePath, archiveCompression, buildManifest, validateManifest,
  looksLikeZipHead, isProjectArchiveName, archiveFileName, importedProjectName,
  archiveSizeVerdict, isSafeArchiveEntry, formatBytes, summarizeSections,
} from './projectArchive.js'

describe('shouldArchivePath', () => {
  it('keeps project data', () => {
    for (const p of ['project.json', 'images/abc-123', 'matches/a--b.json', 'recon.c1.pos.bin']) {
      expect(shouldArchivePath(p)).toBe(true)
    }
  })

  it('always drops the session log', () => {
    expect(shouldArchivePath('log.ndjson')).toBe(false)
    expect(shouldArchivePath('log.json')).toBe(false)
  })

  it('drops only the derived trees when derived data is excluded', () => {
    for (const dir of ARCHIVE_DERIVED_DIRS) {
      expect(shouldArchivePath(`${dir}/x.bin`, { includeDerived: false })).toBe(false)
      expect(shouldArchivePath(`${dir}/x.bin`, { includeDerived: true })).toBe(true)
    }
    // A same-named file at the root is not the directory.
    expect(shouldArchivePath('images/abc', { includeDerived: false })).toBe(true)
    expect(shouldArchivePath('gcps.json', { includeDerived: false })).toBe(true)
  })
})

describe('archiveCompression', () => {
  it('deflates JSON and stores everything else', () => {
    expect(archiveCompression('project.json')).toBe(8)
    expect(archiveCompression('depthmaps/index.json')).toBe(8)
    expect(archiveCompression('recon.c.pos.bin')).toBe(0)
    expect(archiveCompression('images/uuid-with-no-extension')).toBe(0)
    expect(archiveCompression('masks/x.png')).toBe(0)
  })
})

describe('manifest', () => {
  const project = { name: 'Antarctica', sceneType: 'aerial', crs: 'EPSG:3031', createdAt: '2026-01-01T00:00:00.000Z' }

  it('round-trips through validate', () => {
    const m = buildManifest({ project, appVersion: '0.0.0' })
    expect(validateManifest(m)).toEqual({ ok: true, manifest: m })
    expect(m.project).toEqual(project)
    expect(m.version).toBe(PROJECT_ARCHIVE_VERSION)
  })

  it('rejects non-manifests', () => {
    expect(validateManifest(null).ok).toBe(false)
    expect(validateManifest({}).ok).toBe(false)
    expect(validateManifest({ format: 'colmap', version: 1 }).ok).toBe(false)
  })

  it('rejects an archive from a newer app, naming both versions', () => {
    const m = buildManifest({ project })
    const res = validateManifest({ ...m, version: PROJECT_ARCHIVE_VERSION + 1 })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/newer version/)
    expect(res.error).toContain(`v${PROJECT_ARCHIVE_VERSION + 1}`)
  })

  it('rejects a malformed version rather than treating it as old', () => {
    const m = buildManifest({ project })
    expect(validateManifest({ ...m, version: 'one' }).ok).toBe(false)
    expect(validateManifest({ ...m, version: 0 }).ok).toBe(false)
  })
})

describe('sniffing', () => {
  it('recognises a ZIP local-header signature', () => {
    expect(looksLikeZipHead(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true)
    expect(looksLikeZipHead(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe(true)  // empty archive
    expect(looksLikeZipHead(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(false) // PNG
    expect(looksLikeZipHead(new Uint8Array([0x50]))).toBe(false)
  })

  it('recognises the extension case-insensitively', () => {
    expect(isProjectArchiveName('a.websfm')).toBe(true)
    expect(isProjectArchiveName('A.WEBSFM')).toBe(true)
    expect(isProjectArchiveName('a.zip')).toBe(false)
  })
})

describe('naming', () => {
  it('sanitises the download name', () => {
    expect(archiveFileName('Ross/Ice: Shelf')).toBe('Ross-Ice- Shelf.websfm')
    expect(archiveFileName('   ')).toBe('project.websfm')
  })

  it('suffixes only on collision', () => {
    expect(importedProjectName('A', ['B'])).toBe('A')
    expect(importedProjectName('A', ['A'])).toBe('A (imported)')
    expect(importedProjectName('A', ['A', 'A (imported)'])).toBe('A (imported 2)')
  })
})

describe('archiveSizeVerdict', () => {
  it('accepts a normal project and refuses past the ZIP32 ceiling', () => {
    expect(archiveSizeVerdict(500 * 1024 * 1024).ok).toBe(true)
    const bad = archiveSizeVerdict(5 * 1024 ** 3)
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/4 GB/)
  })
})

describe('isSafeArchiveEntry', () => {
  it('rejects anything that escapes the project directory', () => {
    expect(isSafeArchiveEntry('images/abc')).toBe(true)
    expect(isSafeArchiveEntry('../../etc/passwd')).toBe(false)
    expect(isSafeArchiveEntry('images/../../x')).toBe(false)
    expect(isSafeArchiveEntry('/abs/path')).toBe(false)
    expect(isSafeArchiveEntry('C:\\win')).toBe(false)
    expect(isSafeArchiveEntry('images/')).toBe(false)   // directory marker
    expect(isSafeArchiveEntry('')).toBe(false)
  })
})

describe('reporting helpers', () => {
  it('formats bytes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 kB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
  })

  it('sums by top-level section, largest first', () => {
    expect(summarizeSections([
      { relPath: 'project.json', size: 10 },
      { relPath: 'images/a', size: 100 },
      { relPath: 'images/b', size: 50 },
    ])).toEqual([{ section: 'images', bytes: 150 }, { section: 'project', bytes: 10 }])
  })
})
