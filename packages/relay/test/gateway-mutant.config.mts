import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { gatewayMutations } from './gateway-mutations.mjs'

const root = resolve(import.meta.dirname, '../../..'), name = process.env.RELAY_GATEWAY_MUTATION
if (name && !Object.hasOwn(gatewayMutations, name)) throw Error('Unknown Relay gateway mutation')
const variant = name ? gatewayMutations[name as keyof typeof gatewayMutations] : undefined
const recorded = new Set(Object.values(gatewayMutations).flatMap(value => [value.file, value.test]))
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({
  cacheDir: resolve(root, '.tmp/relay-gateway-cache', name ?? 'baseline'),
  plugins: [{ name: 'relay-gateway-loaded-source', enforce: 'pre', transform(original, id) {
    const file = id.split('?')[0]!, path = relative(root, file)
    if (!recorded.has(path)) return
    let code = original
    if (variant?.file === path) {
      if (code.split(variant.before).length !== 2) throw Error('Mutation anchor must be unique')
      code = code.replace(variant.before, variant.after)
    }
    const loaded = process.env.RELAY_GATEWAY_LOADED
    if (!loaded) return code === original ? undefined : { code, map: null }
    const fact = { path, mutation: variant?.file === path ? name : null, originalSHA256: sha(readFileSync(file, 'utf8')), loadedSHA256: sha(code) }
    return { code: code + '\nimport {appendFileSync as __recordRelayLoaded} from "node:fs";\n__recordRelayLoaded(' + JSON.stringify(loaded) + ',' + JSON.stringify(JSON.stringify(fact) + '\n') + ');\n', map: null }
  } }],
  test: { include: variant ? [variant.test] : [...new Set(Object.values(gatewayMutations).map(value => value.test))],
    ...(variant ? { testNamePattern: variant.target } : {}), maxWorkers: 1, fileParallelism: false, testTimeout: 15000, passWithNoTests: false },
})
