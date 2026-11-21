import { registerHooks } from 'node:module'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { instrumentModelStateNativeRpc } from './model-state-native-trace.mjs'

const root = resolve(import.meta.dirname, '../../../..')
const candidate = process.env.AMX_INFORMATION_CANDIDATE
if (!candidate) throw new Error('An exact private Agent information candidate is required.')
const manifests = Object.fromEntries(['core', 'providers'].map(name => [name,
  JSON.parse(readFileSync(join(candidate, name, 'package.json'), 'utf8'))]))
const hash = value => createHash('sha256').update(value).digest('hex')
const edits = process.env.AMX_INFORMATION_COMPILED_EDIT ? JSON.parse(process.env.AMX_INFORMATION_COMPILED_EDIT) : null
const nodeEdit = process.env.AMX_MODEL_SYNC_NODE_EDIT ? JSON.parse(process.env.AMX_MODEL_SYNC_NODE_EDIT) : null
let registration
export function installInformationCandidateLoader() {
  registration?.deregister()
  registration = registerHooks({
  resolve(specifier, context, next) {
    for (const [name, manifest] of Object.entries(manifests)) {
      const prefix = '@agentmux/' + name
      if (specifier !== prefix && !specifier.startsWith(prefix + '/')) continue
      const key = specifier === prefix ? '.' : '.' + specifier.slice(prefix.length)
      const entry = manifest.exports?.[key]?.import
      if (!entry?.startsWith('./dist/')) throw new Error('The candidate package does not export: ' + specifier)
      return { url: pathToFileURL(resolve(candidate, name, entry)).href, shortCircuit: true }
    }
    const source = specifier.startsWith('file:') ? fileURLToPath(specifier)
      : specifier.startsWith('.') && context.parentURL?.startsWith('file:') ? resolve(dirname(fileURLToPath(context.parentURL)), specifier) : undefined
    if (source) for (const name of ['core', 'providers']) for (const directory of ['src', 'dist']) {
      const prefix = resolve(root, 'packages', name, directory) + '/'
      if (!source.startsWith(prefix) || !/\.(?:ts|js)$/u.test(source)) continue
      const target = resolve(candidate, name, 'dist', source.slice(prefix.length).replace(/\.ts$/u, '.js'))
      if (!existsSync(target)) throw new Error('The exact candidate module is missing: ' + relative(candidate, target))
      return next(pathToFileURL(target).href, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    if (!url.startsWith('file:')) return result
    const file = fileURLToPath(url), path = relative(candidate, file), sourcePath = relative(root, file)
    if (process.env.AMX_MODEL_SYNC_LOADED && /^(?:apps\/(?:desktop|host)\/src\/).+\.(?:ts|tsx)$/u.test(sourcePath)) {
      const original = readFileSync(file, 'utf8'), loaded = String(result.source)
      let source = loaded
      if (nodeEdit?.path === sourcePath) {
        if (source.split(nodeEdit.before).length !== 2) throw new Error('The Main source mutation requires one exact anchor.')
        source = source.replace(nodeEdit.before, nodeEdit.after)
      }
      appendFileSync(process.env.AMX_MODEL_SYNC_LOADED, JSON.stringify({ path: sourcePath, originalSHA256: hash(original),
        sha256: hash(source), transform: 'node-typescript', ...(source === loaded ? {} : { mutation: nodeEdit.mutation }) }) + '\n')
      return source === loaded ? result : { ...result, source }
    }
    if (!/^(?:core|providers)\/dist\/.+\.js$/u.test(path)) return result
    const original = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    let source = original
    if (edits?.path === path) {
      if (source.split(edits.before).length !== 2) throw new Error('The compiled mutation must have one exact anchor: ' + edits.mutation)
      source = source.replace(edits.before, edits.after)
    }
    const instrumented = path === 'providers/dist/codex/native-rpc.js' && Boolean(process.env.AMX_MODEL_SYNC_NATIVE_TRACE)
    if (instrumented) source = instrumentModelStateNativeRpc(source, process.env.AMX_MODEL_SYNC_NATIVE_TRACE)
    if (process.env.AMX_INFORMATION_COMPILED_LOADED) appendFileSync(process.env.AMX_INFORMATION_COMPILED_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), sha256: hash(source),
        ...(edits?.path === path && original !== source ? { mutation: edits.mutation } : {}), ...(instrumented ? { instrumentation: 'native-rpc-frame-trace' } : {}) }) + '\n')
    return source === original ? result : { ...result, source }
  }
  })
}
installInformationCandidateLoader()
