import { defineConfig } from 'vitest/config'
import { readFileSync, appendFileSync } from 'node:fs'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'
const root = resolve(import.meta.dirname, '../../../../..')
const mutant = process.env.AGENTMUX_PROTOCOL_MUTANT ?? 'baseline'
const changes: Record<string, [string, string, string]> = {
  'host-test-depth': ['packages/core/src/control-codec.ts', "const fields = settingsResourceEnvelope(result, ['input', 'outcome', 'detail'], code)", "const fields = settingsResourceEnvelope(settingsResourceRecord(result, code), ['input', 'outcome', 'detail'], code)"],
  'host-list-depth': ['packages/core/src/control-codec.ts', "const fields = settingsResourceEnvelope(result, ['hosts'], code)", "const fields = settingsResourceEnvelope(settingsResourceRecord(result, code), ['hosts'], code)"],
  'refresh-depth': ['packages/core/src/control-codec.ts', "const fields = settingsResourceEnvelope(result, ['input', 'availability', 'executable', 'cause'], code)", "const fields = settingsResourceEnvelope(settingsResourceRecord(result, code), ['input', 'availability', 'executable', 'cause'], code)"],
  'host-array-descriptor': ['packages/core/src/control-codec.ts', "if (!descriptor?.enumerable || !('value' in descriptor)) throw new AgentMuxError('Host list is invalid.', code)", "if (!descriptor) throw new AgentMuxError('Host list is invalid.', code)"],
  'settings-leaf-depth': ['packages/core/src/settings-resource-json.ts', 'const MAX_DEPTH = 8', 'const MAX_DEPTH = 9'],
  'receipt-byte-budget': ['packages/core/src/control-codec.ts', "settingsResourceBudget(receipt, 'CONTROL_PROTOCOL_ERROR')", '/* actual whole-receipt byte boundary removed */'],
  'host-header': ['packages/core/src/control-codec.ts', "operation?.value === 'settings.hosts.list' || operation?.value === 'settings.hosts.test'", 'false']
}
const sha = (s: string) => createHash('sha256').update(s).digest('hex')
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/performance-protocol-boundaries', mutant),
  plugins: [{ name: 'actual-settings-composition-mutant', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!), change = changes[mutant]
    if (!['packages/core/src/control-codec.ts', 'packages/core/src/settings-resource-json.ts'].includes(path)) return
    assert.equal(input, readFileSync(id.split('?')[0]!, 'utf8'))
    let code = input
    if (change?.[0] === path) { assert.ok(input.includes(change[1])); code = input.replace(change[1], change[2]); assert.notEqual(code, input) }
    appendFileSync(process.env.AGENTMUX_PROTOCOL_LOADED!, JSON.stringify({ path, sourceSHA256: sha(input), consumedSHA256: sha(code) }) + '\n')
    return { code, map: null }
  } }],
  test: { include: ['apps/desktop/test/performance-protocol-boundaries.test.ts', ...(process.env.AGENTMUX_PROTOCOL_ADJACENT ? ['packages/core/test/agentmux-cli-settings-hosts.test.ts', 'packages/core/test/control-settings-executor-refresh.test.ts'] : [])], passWithNoTests: false, maxWorkers: 1, testTimeout: 15000, hookTimeout: 15000 }
})
