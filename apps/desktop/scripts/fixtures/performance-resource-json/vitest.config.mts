import { defineConfig } from 'vitest/config'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'
const root = resolve(import.meta.dirname, '../../../../..')
const mutant = process.env.AGENTMUX_METRICS_JSON_MUTANT ?? 'baseline'
const changes: Record<string, [string, string, string]> = {
  'snapshot-depth': ['packages/core/src/toolkit.ts', '  const source = settingsResourceEnvelope(value, [', "  const source = settingsResourceEnvelope(settingsResourceRecord(value, 'CONTROL_PROTOCOL_ERROR'), ["],
  'result-depth': ['packages/core/src/toolkit.ts', "  const r = envelope(value, ['snapshot'])", "  const r = record(value, ['snapshot'])"],
  'metrics-schema': ['packages/core/src/toolkit.ts', 'const obs = parseMetricsObservation(r.observation)', 'const obs = r.observation as MetricsObservation'],
  'record-prototype': ['packages/core/src/metrics.ts', '(Object.getPrototypeOf(source) !== Object.prototype && Object.getPrototypeOf(source) !== null)', 'false'],
  'record-keys': ['packages/core/src/metrics.ts', 'Reflect.ownKeys(source).length', 'Object.keys(source).length'],
  'record-descriptor': ['packages/core/src/metrics.ts', "if (!descriptor?.enumerable || !('value' in descriptor)) invalid()", 'if (!descriptor) invalid()'],
  'array-prototype': ['packages/core/src/metrics.ts', 'Object.getPrototypeOf(v) !== Array.prototype', 'false'],
  'array-keys': ['packages/core/src/metrics.ts', 'Reflect.ownKeys(v).length !== v.length + 1', 'false'],
  'array-descriptor': ['packages/core/src/metrics.ts', "    if (!descriptor?.enumerable || !('value' in descriptor)) invalid()", "    if (!descriptor || !('value' in descriptor)) invalid()"],
  'byte-budget': ['packages/core/src/toolkit.ts', "  settingsResourceBudget(r, 'CONTROL_PROTOCOL_ERROR')", '  /* mutated complete byte boundary */']
}
assert.ok(mutant === 'baseline' || changes[mutant], 'Unknown mutation')
let loaded = false
const evidence = process.env.AGENTMUX_METRICS_JSON_EVIDENCE
if (evidence) mkdirSync(evidence, { recursive: true })
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/performance-resource-json', mutant),
  resolve: { alias: [ { find: /^@agentmux\/core\/control$/, replacement: resolve(root, 'packages/core/src/control.ts') },
    { find: /^@agentmux\/core$/, replacement: resolve(root, 'packages/core/src/index.ts') } ] },
  plugins: [{ name: 'actual-metrics-json-mutant', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!), change = changes[mutant]
    if (!change || change[0] !== path) {
      if (evidence && ['packages/core/src/toolkit.ts', 'packages/core/src/metrics.ts', 'packages/core/src/control-codec.ts', 'packages/core/src/public-rpc-client.ts', 'apps/desktop/src/main/toolkit-ipc.ts'].includes(path)) appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, mutant, sourceSHA256: sha(input), consumedSHA256: sha(input) }) + '\n')
      return
    }
    assert.equal(input, readFileSync(id.split('?')[0]!, 'utf8'), 'Mutates actual production source')
    assert.ok(input.includes(change[1]), 'Nonempty actual production mutation')
    loaded = true
    const code = input.replaceAll(change[1], change[2])
    if (evidence) appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, mutant, sourceSHA256: sha(input), consumedSHA256: sha(code) }) + '\n')
    return { code, map: null }
  }, closeBundle() { if (mutant !== 'baseline') assert.ok(loaded, 'Mutation must be consumed') } }],
  test: { include: ['packages/core/test/toolkit-metrics-json.test.ts', 'apps/desktop/test/toolkit-metrics-json-ipc.test.ts', ...(process.env.AGENTMUX_METRICS_JSON_ADJACENT ? ['packages/core/test/toolkit-control.test.ts', 'packages/core/test/toolkit-custom.test.ts', 'packages/core/test/toolkit-package.test.ts', 'packages/core/test/metrics-control-host.test.ts', 'packages/core/test/agentmux-cli-settings-resources.test.ts', 'apps/desktop/test/toolkit-owner.test.ts'] : [])],
    passWithNoTests: false, maxWorkers: 1, testTimeout: 15000, hookTimeout: 15000 }
})
