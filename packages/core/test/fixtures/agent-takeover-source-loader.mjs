import { stripTypeScriptTypes } from 'node:module'
import { readFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve as pathResolve, relative } from 'node:path'
import { takeoverSource } from './agent-takeover-mutations.mjs'
const root = pathResolve(import.meta.dirname, '../../../..')
const sourceRoot = pathToFileURL(root + '/').href
export async function resolve(specifier, context, next) {
  for (const name of ['core', 'demand']) {
    const prefix = '@agentmux/' + name
    if (specifier !== prefix && !specifier.startsWith(prefix + '/')) continue
    const manifest = JSON.parse(await readFile(pathResolve(root, 'packages', name, 'package.json'), 'utf8'))
    const entry = manifest.exports[specifier === prefix ? '.' : '.' + specifier.slice(prefix.length)]
    if (entry?.import) return { url: pathToFileURL(pathResolve(root, 'packages', name, entry.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))).href, shortCircuit: true }
  }
  if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(url)) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
    const original = await readFile(fileURLToPath(url), 'utf8'), result = takeoverSource(relative(root, fileURLToPath(url)), original, process.env.AGENTMUX_TEST_TAKEOVER_MUTATION)
    if (process.env.AGENTMUX_TEST_TAKEOVER_TRACE) await appendFile(process.env.AGENTMUX_TEST_TAKEOVER_TRACE, JSON.stringify({ loader: 'node', ...result.receipt }) + '\n')
    return { format: 'module', source: stripTypeScriptTypes(result.loaded, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
}
