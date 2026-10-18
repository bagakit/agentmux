import { appendFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as sourceLoader from '../../../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'

const root = pathResolve(import.meta.dirname, '../../../../..')
function record(path, bytes) {
  if (!process.env.AGENTMUX_INITIAL_IDLE_CLI_LOADED) return
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  appendFileSync(process.env.AGENTMUX_INITIAL_IDLE_CLI_LOADED,
    JSON.stringify({ path, originalSHA256: sha256, sha256 }) + '\n')
}
export async function resolve(specifier, context, next) {
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
  const result = await sourceLoader.load(url, context, next)
  if (original) record(path, original)
  return result
}
