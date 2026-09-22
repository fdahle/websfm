import { readBoundedZip } from '../../core/io/boundedZip.js'
self.onmessage = async ({ data: { file, wanted } }) => {
  try {
    const names = wanted ? new Set(wanted) : null
    const result = await readBoundedZip(file, path => names ? names.has(path)
      : /(?:^|\/)(?:[^/]+\.(?:db|sqlite)|cameras\.(?:txt|bin)|images\.(?:txt|bin)|points3d\.(?:txt|bin))$/i.test(path))
    self.postMessage({ result }, result.entries.map(e => e.data.buffer))
  } catch (error) { self.postMessage({ error: error.message }) }
}
