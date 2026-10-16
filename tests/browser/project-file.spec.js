import { test, expect } from '@playwright/test'

// A project saved as a .websfm file and opened again, on real OPFS with the browser's
// own CompressionStream / DecompressionStream: deflated JSON and stored binaries come
// back byte-exact, and the archive reads through its central directory.
test('a project file round-trips through save and open', async ({ page }) => {
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('/')
  await page.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(page.locator('.loading-overlay')).toHaveCount(0)
  const r = await page.evaluate(async () => {
    const opfs = await import('/src/utils/opfs.js')
    const { exportProjectArchive, importProjectArchive, peekArchiveManifest } = await import('/src/utils/projectFile.js')
    const { buildManifest } = await import('/src/core/io/projectArchive.js')
    const { readZipIndex } = await import('/src/utils/zip.js')
    const src = 'pf-src-' + Date.now(), dst = 'pf-dst-' + Date.now()
    const bin = new Float64Array(200000).map((_, i) => Math.sin(i) * 1e6) // 1.6 MB stored
    await opfs.writeProjectFile(src, 'project.json', new Blob([JSON.stringify({ id: src, name: 'Round trip', note: 'x'.repeat(5000) })]))
    await opfs.writeProjectFile(src, 'recon/pos.bin', new Blob([bin.buffer]))
    const chunks = []
    const sink = () => ({ streaming: false, write: (c) => { chunks.push(c.slice()) }, close: async () => {}, abort: () => {} })
    const manifest = buildManifest({ project: { name: 'Round trip', sceneType: 'object', crs: 'local', createdAt: new Date().toISOString() } })
    const out = await exportProjectArchive({ projectId: src, manifest, fileName: 'rt.websfm', openSink: sink })
    const file = new Blob(chunks)
    const index = await readZipIndex(file)
    const peeked = await peekArchiveManifest(file)
    const imp = await importProjectArchive({ file, projectId: dst })
    const files = {}
    for await (const { relPath, file: f } of opfs.walkProjectFiles(dst)) files[relPath] = f
    const back = new Float64Array(await files['recon/pos.bin'].arrayBuffer())
    let same = back.length === bin.length
    for (let i = 0; same && i < bin.length; i++) same = back[i] === bin[i]
    return {
      entries: index.map((e) => [e.name, e.method]), archiveBytes: out.archiveBytes, size: file.size,
      peeked: peeked?.project?.name ?? peeked?.name ?? !!peeked, imported: imp.entryCount,
      project: JSON.parse(await files['project.json'].text()).name, binSame: same,
    }
  })
  expect(r.entries).toEqual([['manifest.json', 8], ['project.json', 8], ['recon/pos.bin', 0]])
  expect(r.archiveBytes).toBe(r.size)
  expect(r.peeked).toBeTruthy()
  expect(r.imported).toBe(2)
  expect(r.project).toBe('Round trip')
  expect(r.binSame).toBe(true)
  expect(errors).toEqual([])
})
