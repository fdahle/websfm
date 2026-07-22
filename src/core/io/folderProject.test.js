import { describe, it, expect } from 'vitest'
import {
  STORAGE_FOLDER, STORAGE_OPFS,
  projectStorage, isFolderProject, folderStorageSupported, folderOpenPlan,
  adoptFolderVerdict, newFolderVerdict, copyVerified, folderLabel,
} from './folderProject.js'

const opfsEntry = { id: 'a', storage: STORAGE_OPFS }
const folderEntry = { id: 'b', storage: STORAGE_FOLDER, folderName: 'survey-2026' }

describe('projectStorage', () => {
  it('defaults to OPFS for pre-folder index entries', () => {
    expect(projectStorage({ id: 'legacy' })).toBe(STORAGE_OPFS)
    expect(projectStorage(null)).toBe(STORAGE_OPFS)
    expect(projectStorage({ storage: 'nonsense' })).toBe(STORAGE_OPFS)
    expect(isFolderProject({ id: 'legacy' })).toBe(false)
  })

  it('recognises a folder project', () => {
    expect(projectStorage(folderEntry)).toBe(STORAGE_FOLDER)
    expect(isFolderProject(folderEntry)).toBe(true)
  })
})

describe('folderStorageSupported', () => {
  it('follows showDirectoryPicker', () => {
    expect(folderStorageSupported({ showDirectoryPicker: () => {} })).toBe(true)
    expect(folderStorageSupported({})).toBe(false)
    expect(folderStorageSupported(null)).toBe(false)
  })
})

describe('folderOpenPlan', () => {
  it('opens an OPFS project without touching handles', () => {
    expect(folderOpenPlan({ entry: opfsEntry })).toEqual({ action: 'open', reason: 'opfs' })
  })

  it('opens a folder project only when permission is already granted', () => {
    expect(folderOpenPlan({ entry: folderEntry, handle: {}, permission: 'granted' }).action).toBe('open')
  })

  it('asks for a gesture rather than retrying, on prompt or denied', () => {
    expect(folderOpenPlan({ entry: folderEntry, handle: {}, permission: 'prompt' }).action).toBe('reconnect')
    expect(folderOpenPlan({ entry: folderEntry, handle: {}, permission: 'denied' }).action).toBe('reconnect')
  })

  it('falls back to re-picking when the handle is gone or unreadable', () => {
    expect(folderOpenPlan({ entry: folderEntry, handle: null }).action).toBe('repick')
    expect(folderOpenPlan({ entry: folderEntry, handle: {}, permission: null }).action).toBe('repick')
  })
})

describe('adoptFolderVerdict', () => {
  it('adopts a folder holding a project', () => {
    expect(adoptFolderVerdict({ hasProjectJson: true, isEmpty: false }).ok).toBe(true)
  })

  it('refuses an empty folder and someone else’s folder, with different reasons', () => {
    const empty = adoptFolderVerdict({ hasProjectJson: false, isEmpty: true })
    const foreign = adoptFolderVerdict({ hasProjectJson: false, isEmpty: false })
    expect(empty.ok).toBe(false)
    expect(foreign.ok).toBe(false)
    expect(empty.error).not.toBe(foreign.error)
  })
})

describe('newFolderVerdict', () => {
  it('accepts an empty folder outright', () => {
    expect(newFolderVerdict({ isEmpty: true, hasProjectJson: false })).toEqual({ ok: true, needsConfirm: false })
  })

  it('asks once about a non-empty folder, then accepts', () => {
    const first = newFolderVerdict({ isEmpty: false, hasProjectJson: false })
    expect(first).toMatchObject({ ok: false, needsConfirm: true })
    expect(newFolderVerdict({ isEmpty: false, hasProjectJson: false, confirmed: true }).ok).toBe(true)
  })

  it('never lets a new project overwrite an existing one, even confirmed', () => {
    const res = newFolderVerdict({ isEmpty: false, hasProjectJson: true, confirmed: true })
    expect(res.ok).toBe(false)
    expect(res.needsConfirm).toBeFalsy()
  })
})

describe('copyVerified', () => {
  it('requires both file count and byte total to match', () => {
    expect(copyVerified({ files: 3, bytes: 10 }, { files: 3, bytes: 10 })).toBe(true)
    expect(copyVerified({ files: 3, bytes: 10 }, { files: 3, bytes: 9 })).toBe(false)
    expect(copyVerified({ files: 3, bytes: 10 }, { files: 2, bytes: 10 })).toBe(false)
    expect(copyVerified(null, { files: 0, bytes: 0 })).toBe(false)
  })
})

describe('folderLabel', () => {
  it('names the leaf directory (the full path is not exposed to web content)', () => {
    expect(folderLabel(folderEntry)).toBe('folder: survey-2026')
    expect(folderLabel({ storage: STORAGE_FOLDER })).toBe('folder')
  })
})
