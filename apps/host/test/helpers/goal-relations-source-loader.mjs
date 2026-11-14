// Real Core CLI plus the current public Demand sources, without shared dist writes.
import { readFileSync } from 'node:fs'
import { resolve as pathResolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolve as sourceResolve, load } from '../../../desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs'
export { load }
const root = pathResolve(import.meta.dirname, '../../../..')
const manifest = JSON.parse(readFileSync(pathResolve(root, 'packages/demand/package.json'), 'utf8'))
export async function resolve(specifier, context, next) {
  if (specifier === '@agentmux/demand' || specifier.startsWith('@agentmux/demand/')) {
    const key = specifier === '@agentmux/demand' ? '.' : './' + specifier.slice('@agentmux/demand/'.length)
    const entry = manifest.exports[key]
    if (entry) {
      const source = entry.types.replace('./dist/src/', 'src/').replace(/\.d\.ts$/, '.ts')
      return { url: pathToFileURL(pathResolve(root, 'packages/demand', source)).href, shortCircuit: true }
    }
  }
  return await sourceResolve(specifier, context, next)
}
