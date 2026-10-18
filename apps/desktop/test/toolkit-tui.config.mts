import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import owning from '../scripts/fixtures/toolkit-custom/vitest.config.mts'

const owner = 'apps/desktop/src/main/toolkit-custom-owner.ts'
const changes: Record<string, [string, string, string]> = {
  'raw-ownership': ['apps/desktop/src/main/runtime-controller.ts', "if (output === 'raw') this.toolkitRuns.set", 'if (true) this.toolkitRuns.set'],
  'repeat-load': [owner, 'const added = [...enabled].filter(id => !this.enabledTuis.has(id))', 'const added = [...enabled]'],
  'dispose-stop': [owner, '// The durable Run outlives this host owner; closing its observer is not Stop.', 'await execution.port?.stop(ref(execution))'],
  'service-membership': ['apps/desktop/src/renderer/src/lib/run-service-projection.ts', '!retained.has(key) && !listeners.has(key)', '!retained.has(key)']
}
const mutant = process.env.AGENTMUX_TUI_MUTATION
assert.ok(!mutant || changes[mutant], 'Mutation names an implemented TUI boundary')
export default defineConfig({ ...owning, plugins: [...(owning.plugins ?? []), {
  name: 'toolkit-tui-boundary-mutation', enforce: 'pre', transform(source, id) {
    const change = mutant ? changes[mutant] : undefined
    if (!change || relative(owning.root!, id.split('?')[0]!) !== change[0]) return
    assert.equal(source.split(change[1]).length, 2, 'Mutation must change one actual product source expression')
    const code = source.replace(change[1], change[2])
    const receipt = process.env.AGENTMUX_TUI_MUTATION_RECEIPT
    if (receipt) appendFileSync(receipt, JSON.stringify({ mutant, file: change[0],
      original: createHash('sha256').update(source).digest('hex'), consumed: createHash('sha256').update(code).digest('hex') }) + '\n')
    return { code, map: null }
  }
}], test: { ...owning.test,
  include: ['apps/desktop/test/toolkit-tui-runtime.test.ts', 'apps/desktop/test/toolkit-tui-owner.test.ts',
    'apps/desktop/test/toolkit-custom-owner.test.ts', 'apps/desktop/test/toolkit-owner.test.ts',
    'apps/desktop/test/run-service-projection.test.ts'] } })
