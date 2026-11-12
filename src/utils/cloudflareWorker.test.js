import { it, expect } from 'vitest'
import worker from '../../deploy/cloudflare/worker.js'

it('answers a malformed URL escape with 400, not a crash', async () => {
  const env = { LARGE_FILES: { get: async () => null }, ASSETS: { fetch: async () => new Response('x') } }
  const res = await worker.fetch(new Request('https://websfm.app/models/%E0%A4%A.onnx'), env)
  expect(res.status).toBe(400)
  // A well-formed missing model stays a 404.
  expect((await worker.fetch(new Request('https://websfm.app/models/none.onnx'), env)).status).toBe(404)
})
