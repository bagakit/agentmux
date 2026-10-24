import { appendFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'
import * as sourceLoader from '../performance-failure-evidence/source-loader.mjs'
import { transformMessageMetadata } from './mutations.mjs'

const root = pathResolve(import.meta.dirname, '../../../../..')
const hash = value => createHash('sha256').update(value).digest('hex')
function record(path, source, compiled = source) {
  if (process.env.AGENTMUX_MESSAGE_METADATA_LOADED) appendFileSync(process.env.AGENTMUX_MESSAGE_METADATA_LOADED,
    JSON.stringify({ path, original: hash(source), input: hash(source), compiled: hash(compiled), consumer: 'source-cli' }) + '\n')
}
export async function resolve(specifier, context, next) {
  const match = specifier.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (match) {
    const directory = pathResolve(root, 'packages', match[1]), manifest = pathResolve(directory, 'package.json')
    const source = await readFile(manifest, 'utf8'); record(relative(root, manifest), source)
    const entry = JSON.parse(source).exports?.[match[2] ? '.' + match[2] : '.']?.import
    if (typeof entry === 'string' && entry.startsWith('./dist/')) {
      const sourcePath = pathResolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      if (existsSync(sourcePath)) return { url: pathToFileURL(sourcePath).href, shortCircuit: true }
    }
  }
  return sourceLoader.resolve(specifier, context, next)
}
export async function load(url, context, next) {
  const path = url.startsWith('file:') ? relative(root, fileURLToPath(url)) : ''
  if (path.startsWith('packages/') && !path.includes('/node_modules/') && path.endsWith('.ts')) {
    const original = await readFile(fileURLToPath(url), 'utf8')
    const changed = transformMessageMetadata(original, path, process.env.AGENTMUX_MESSAGE_METADATA_MUTATION)
    record(path, original, changed)
    return { format: 'module', source: stripTypeScriptTypes(changed, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  if (path.startsWith('packages/') && !path.includes('/node_modules/') && path.endsWith('.js')) record(path, await readFile(fileURLToPath(url)))
  return sourceLoader.load(url, context, next)
}
