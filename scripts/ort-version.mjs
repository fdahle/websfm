import { readFileSync } from 'node:fs'
export const ortVersion = JSON.parse(readFileSync(new URL('../node_modules/onnxruntime-web/package.json', import.meta.url), 'utf8')).version
