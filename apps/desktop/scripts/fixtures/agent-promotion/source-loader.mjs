import { stripTypeScriptTypes } from 'node:module'
import { readFile, appendFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { relative, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { acceptedPromotionSource } from './owner-mutations.mjs'
const root = pathResolve(import.meta.dirname, '../../../../..'), prefix = pathToFileURL(root + '/').href
export async function resolve(specifier, context, next) {
  for (const name of ['core', 'host', 'demand']) {
    const packageName = '@agentmux/' + name
    if (specifier !== packageName && !specifier.startsWith(packageName + '/')) continue
    const directory = pathResolve(root, name === 'host' ? 'apps' : 'packages', name), manifest = JSON.parse(await readFile(pathResolve(directory, 'package.json'), 'utf8'))
    const entry = manifest.exports[specifier === packageName ? '.' : '.' + specifier.slice(packageName.length)]
    if (entry?.import) return { url: pathToFileURL(pathResolve(directory, entry.import.replace('./dist/', name === 'demand' ? './' : './src/').replace(/\.js$/, '.ts'))).href, shortCircuit: true }
  }
  if (context.parentURL?.startsWith(prefix) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (existsSync(url)) return { url: url.href, shortCircuit: true }
  }
  return next(specifier, context)
}
export async function load(url, context, next) {
  if (url.startsWith(prefix) && url.endsWith('.ts')) {
    const result = acceptedPromotionSource(relative(root, fileURLToPath(url)), await readFile(fileURLToPath(url), 'utf8'), process.env.AGENT_PROMOTION_HOST_MUTANT)
    if (process.env.AGENT_PROMOTION_HOST_LOADED) await appendFile(process.env.AGENT_PROMOTION_HOST_LOADED, JSON.stringify({ ...result.trace, loader: 'node', pid: process.pid, role: process.env.AGENT_PROMOTION_OWNER_ROLE ?? 'scenario' }) + '\n')
    return { format: 'module', source: stripTypeScriptTypes(result.loaded, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return next(url, context)
}
