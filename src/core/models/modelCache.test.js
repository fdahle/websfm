import { it, expect } from 'vitest'
import { modelBytesProblem, MIN_MODEL_BYTES } from './modelCache.js'

const html = new TextEncoder().encode('\n<!doctype html><html><head></head></html>')
const onnx = () => {
  const b = new Uint8Array(MIN_MODEL_BYTES * 2)
  b[0] = 0x08
  b[1] = 0x07
  return b
}

it('recognises an SPA fallback page as not-a-model', () => {
  expect(modelBytesProblem({ head: html, size: html.length })).toMatch(/HTML/)
  expect(modelBytesProblem({ contentType: 'text/html; charset=utf-8' })).toMatch(/HTML/)
  expect(modelBytesProblem({ size: 1200 })).toMatch(/1200 bytes/)
  expect(modelBytesProblem({ head: onnx(), size: onnx().length, contentType: 'application/octet-stream' })).toBeNull()
})
