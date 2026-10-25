import { afterEach, describe, expect, it } from 'vitest'
import { pickSaveTarget } from './download.js'

afterEach(() => {
  delete globalThis.window
})

describe('pickSaveTarget', () => {
  it('writes the Blob to the picked file and closes it', async () => {
    const calls = []
    globalThis.window = {
      showSaveFilePicker: async (opts) => {
        calls.push(['pick', opts.suggestedName])
        return {
          createWritable: async () => ({
            write: async (b) => calls.push(['write', await b.text()]),
            close: async () => calls.push(['close']),
          }),
        }
      },
    }
    const target = await pickSaveTarget('a.ply', [])
    expect(target.picked).toBe(true)
    await target.save(new Blob(['xyz']))
    expect(calls).toEqual([['pick', 'a.ply'], ['write', 'xyz'], ['close']])
  })

  it('returns null when the user cancels', async () => {
    globalThis.window = {
      showSaveFilePicker: async () => {
        throw Object.assign(new Error('cancel'), { name: 'AbortError' })
      },
    }
    expect(await pickSaveTarget('a.ply', [])).toBeNull()
  })

  it('aborts the file when the write fails', async () => {
    let aborted = false
    globalThis.window = {
      showSaveFilePicker: async () => ({
        createWritable: async () => ({
          write: async () => {
            throw new Error('disk full')
          },
          close: async () => {},
          abort: async () => {
            aborted = true
          },
        }),
      }),
    }
    const target = await pickSaveTarget('a.ply', [])
    await expect(target.save(new Blob(['x']))).rejects.toThrow('disk full')
    expect(aborted).toBe(true)
  })

  it('falls back to a download when the dialog is refused', async () => {
    globalThis.window = {
      showSaveFilePicker: async () => {
        throw Object.assign(new Error('gesture'), { name: 'SecurityError' })
      },
    }
    const target = await pickSaveTarget('a.ply', [])
    expect(target.picked).toBe(false)
  })
})
