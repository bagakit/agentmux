import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { backpressureMutations } from './backpressure-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')
const name = process.env.RELAY_BACKPRESSURE_MUTATION
if (name && !Object.hasOwn(backpressureMutations, name)) throw Error('Unknown Relay mutation: ' + name)
const variant = name ? backpressureMutations[name as keyof typeof backpressureMutations] : undefined
const recorded = new Set(Object.values(backpressureMutations).flatMap(entry => [entry.file, entry.test]))
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({
  cacheDir: resolve(root, '.tmp/relay-backpressure-cache', name ?? 'baseline'),
  plugins: [{
    name: 'relay-backpressure-loaded-source', enforce: 'pre',
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!recorded.has(path)) return
      let code = original
      if (variant?.file === path) {
        if (code.split(variant.before).length !== 2) throw Error('Mutation anchor must be unique: ' + name)
        code = code.replace(variant.before, variant.after)
      }
      const report = process.env.RELAY_BACKPRESSURE_LOADED
      if (!report) return code === original ? undefined : { code, map: null }
      const fact = { path, mutation: variant?.file === path ? name : null,
        originalSHA256: sha(readFileSync(id.split('?')[0]!, 'utf8')), loadedSHA256: sha(code) }
      return { code: code + '\nimport { appendFileSync as __relayLoaded } from "node:fs";\n__relayLoaded('
        + JSON.stringify(report) + ',' + JSON.stringify(JSON.stringify(fact) + '\n') + ');\n', map: null }
    }
  }],
  test: { include: variant ? [variant.test] : [...new Set(Object.values(backpressureMutations).map(entry => entry.test))],
    ...(variant ? { testNamePattern: variant.target } : {}),
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
})
