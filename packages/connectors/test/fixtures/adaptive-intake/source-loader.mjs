import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as sourceLoader from '../../../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'
function transformSource(source, path) {
  return process.env.ADAPTIVE_REOPEN_BUDGET && path.endsWith('/agent-message-input.ts') ? source.replace('const INLINE_MESSAGE_BYTES = 16 * 1024', 'const INLINE_MESSAGE_BYTES = Number.MAX_SAFE_INTEGER') : source
}

const root = pathResolve(import.meta.dirname, '../../../../..')
function record(path, bytes, transformed = bytes) {
  if (!process.env.ADAPTIVE_INTAKE_LOADED) return
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const changed = Buffer.compare(Buffer.from(bytes), Buffer.from(transformed)) !== 0
  appendFileSync(process.env.ADAPTIVE_INTAKE_LOADED,
    JSON.stringify({ path, originalSHA256: sha256, loadedSHA256: createHash('sha256').update(transformed).digest('hex'),
      ...(changed ? { mutation: process.env.ADAPTIVE_REOPEN_BUDGET } : {}) }) + '\n')
}
export async function resolve(specifier, context, next) {
  if (specifier === '@agentmux/identity/runtime-source') return {
    url: pathToFileURL(pathResolve(root, 'packages/identity/dist/runtime-source.js')).href, shortCircuit: true }
  const match = specifier.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (match) {
    const directory = pathResolve(root, 'packages', match[1]), manifest = pathResolve(directory, 'package.json')
    const source = await readFile(manifest, 'utf8')
    record(relative(root, manifest), source)
    const entry = JSON.parse(source).exports?.[match[2] ? '.' + match[2] : '.']?.import
    if (typeof entry === 'string' && entry.startsWith('./dist/')) {
      const path = pathResolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      return { url: pathToFileURL(path).href, shortCircuit: true }
    }
  }
  return sourceLoader.resolve(specifier, context, next)
}
export async function load(url, context, next) {
  const path = url.startsWith('file:') ? relative(root, fileURLToPath(url)) : ''
  const original = path.startsWith('packages/') && !path.includes('/node_modules/') ? await readFile(fileURLToPath(url)) : undefined
  const changed = original && path.endsWith('.ts') ? transformSource(original.toString(), path) : original
  const result = await sourceLoader.load(url, context, next)
  if (original) record(path, original, changed)
  if (original && changed !== original && String(changed) !== original.toString()) {
    const ts = await import('typescript')
    return { ...result, source: ts.transpileModule(String(changed), { fileName: path, compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText }
  }
  return result
}
