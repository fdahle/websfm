import { readdir, readFile } from 'node:fs/promises'
import { parse, compileScript, compileTemplate } from '@vue/compiler-sfc'

const files = (await readdir('src', { recursive: true })).filter(file => file.endsWith('.vue'))
let errors = 0
for (const file of files) {
  const filename = `src/${file}`
  const { descriptor, errors: parseErrors } = parse(await readFile(filename, 'utf8'), { filename })
  if (parseErrors.length) throw new Error(`${filename}: ${parseErrors.join(', ')}`)
  if (!descriptor.template) continue
  const script = descriptor.script || descriptor.scriptSetup ? compileScript(descriptor, { id: filename }) : null
  const compiled = compileTemplate({ id: filename, filename, source: descriptor.template.content,
    compilerOptions: { bindingMetadata: script?.bindings } })
  const unbound = [...new Set([...compiled.code.matchAll(/\b_ctx\.([a-zA-Z_$][\w$]*)/g)]
    .map(match => match[1]).filter(name => !name.startsWith('$')))]
  if (compiled.errors.length || unbound.length) {
    console.error(`${filename}: ${[...compiled.errors, ...unbound.map(name => `undeclared template binding ${name}`)].join(', ')}`)
    errors++
  }
}
if (errors) process.exitCode = 1
else console.log(`Checked template bindings in ${files.length} Vue components`)
