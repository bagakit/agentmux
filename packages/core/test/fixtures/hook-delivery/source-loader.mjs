// Private source CLI qualification. It does not qualify a compiled or installed launcher.
import { appendFileSync, existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as sourceLoader from '../../../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'

const root = pathResolve(import.meta.dirname, '../../../../..')
function record(path, source) {
  const report = process.env.AGENTMUX_TEST_HOOK_DELIVERY_CLI_LOADED
  if (report) appendFileSync(report, JSON.stringify({ path,
    sha256: createHash('sha256').update(source).digest('hex') }) + '\n')
}
export async function resolve(specifier, context, next) {
  const match = specifier.match(/^@agentmux\/([^/]+)(.*)$/u)
  if (match) {
    const directory = pathResolve(root, 'packages', match[1]), manifest = pathResolve(directory, 'package.json')
    const source = await readFile(manifest, 'utf8'); record(relative(root, manifest), source)
    const entry = JSON.parse(source).exports?.[match[2] ? '.' + match[2] : '.']?.import
    if (typeof entry === 'string' && entry.startsWith('./dist/')) {
      const path = pathResolve(directory, entry.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      if (existsSync(path)) return { url: pathToFileURL(path).href, shortCircuit: true }
      const generated = pathResolve(directory, entry)
      if (existsSync(generated)) return { url: pathToFileURL(generated).href, shortCircuit: true }
    }
  }
  return sourceLoader.resolve(specifier, context, next)
}
export async function load(url, context, next) {
  const path = url.startsWith('file:') ? relative(root, fileURLToPath(url)) : ''
  if (path.startsWith('packages/') && !path.includes('/node_modules/') && /\.(?:ts|js)$/u.test(path))
    record(path, await readFile(fileURLToPath(url)))
  return sourceLoader.load(url, context, next)
}
