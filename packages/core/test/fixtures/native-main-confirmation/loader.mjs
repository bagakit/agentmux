import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as original from '../a2a-resumed-inbox/source-loader.mjs'
import { transformNativeMainConfirmationSource } from './mutations.mjs'

const root = pathResolve(import.meta.dirname, '../../../../..')
export const resolve = original.resolve
export async function load(url, context, next) {
  const result = await original.load(url, context, next)
  if (!url.startsWith('file:')) return result
  const path = relative(root, fileURLToPath(url))
  if (!path.startsWith('packages/') || path.includes('/node_modules/') || !path.endsWith('.ts')) return result
  const bytes = await readFile(fileURLToPath(url), 'utf8')
  const mutation = process.env.AGENTMUX_NATIVE_MAIN_MUTATION ?? process.env.NATIVE_MAIN_PROOF_MUTATION
  const trace = process.env.AGENTMUX_NATIVE_MAIN_LOADED ?? process.env.NATIVE_MAIN_PROOF_LOADED
  const changed = transformNativeMainConfirmationSource(bytes, path, mutation)
  const hash = value => createHash('sha256').update(value).digest('hex')
  if (trace) appendFileSync(trace,
    JSON.stringify({ pid: process.pid, path, originalSHA256: hash(bytes), sha256: hash(changed),
      ...(bytes === changed ? {} : { mutation }) }) + '\n')
  if (changed === bytes) return result
  const ts = await import('typescript')
  return { ...result, source: ts.transpileModule(changed, { fileName: path,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText }
}
