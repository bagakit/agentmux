// Original source URLs keep executable helper guards honest; no stale Core dist or bundle is loaded.
import { registerHooks, createRequire } from 'node:module'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const ts = createRequire(new URL('../../package.json', import.meta.url))('typescript')
const mutation = JSON.parse(process.env.AGENTMUX_SOURCE_MUTATION_JSON ?? '[]'), applied = new Set()
const hash = value => createHash('sha256').update(value).digest('hex')
function record(path, original, loaded = original, kind = 'module-load') {
  if (process.env.AGENTMUX_SOURCE_LOAD_LOG) appendFileSync(process.env.AGENTMUX_SOURCE_LOAD_LOG, JSON.stringify({ pid: process.pid, path,
    sourceSHA256: hash(original), loadedSHA256: hash(loaded), mutations: [...applied], kind }) + '\n', { mode: 0o600 })
}
// CJS addons and the compiler loaded before hook registration still have an actual loaded cache entry.
// Capture those bytes now as well, so a later dependency edit cannot replace their load-time evidence.
for (const [path, module] of Object.entries(createRequire(import.meta.url).cache)) if (module?.loaded && existsSync(path)) record(path, readFileSync(path), undefined, 'initial-loaded-cjs-cache')
process.on('exit', () => {
  for (const [path, module] of Object.entries(createRequire(import.meta.url).cache)) if (module?.loaded && existsSync(path)) record(path, readFileSync(path), undefined, 'loaded-cjs-cache')
})
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.endsWith('.js') && (specifier.startsWith('file:') || specifier.startsWith('/') || specifier.startsWith('.') && context.parentURL?.startsWith('file:'))) {
      const path = fileURLToPath(new URL(specifier, context.parentURL ?? 'file:///')), source = path.slice(0, -3) + '.ts'
      if (!existsSync(path) && existsSync(source)) return { url: pathToFileURL(source).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith('file:')) return next(url, context)
    if (!url.endsWith('.ts')) {
      const result = next(url, context), path = fileURLToPath(url)
      if (existsSync(path)) record(path, readFileSync(path))
      return result
    }
    const path = fileURLToPath(url), original = readFileSync(path, 'utf8')
    let source = original
    for (let index = 0; index < mutation.length; index++) {
      const change = mutation[index]
      if (!path.endsWith(change.path)) continue
      if (!source.includes(change.from)) throw new Error(`Mutation anchor missing: ${change.path}`)
      source = source.replace(change.from, change.to); applied.add(index)
    }
    record(path, original, source)
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(source, { fileName: path,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true, esModuleInterop: true } }).outputText }
  }
})
