import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const sourceRoot = new URL('../../src/', import.meta.url).href
export async function resolve(specifier, context, nextResolve) {
  if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const target = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
    if (target.href.startsWith(sourceRoot) && existsSync(target)) return { url: target.href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
export async function load(url, context, nextLoad) {
  if (url.startsWith(sourceRoot) && url.endsWith('.ts')) {
    const source = readFileSync(new URL(url), 'utf8')
    if (process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS) appendFileSync(process.env.AGENTMUX_TEST_RECEIPT_SOURCE_LOADS,
      JSON.stringify({ path: fileURLToPath(url), sha256: createHash('sha256').update(source).digest('hex') }) + '\n', { mode: 0o600 })
    return { format: 'module', source: stripTypeScriptTypes(source, { mode: 'transform', sourceUrl: url }), shortCircuit: true }
  }
  return nextLoad(url, context)
}
