import { defineConfig } from 'vitest/config'
import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import owning from '../scripts/fixtures/toolkit-custom/vitest.config.mts'

const owner = 'apps/desktop/src/main/toolkit-custom-owner.ts'
const changes: Record<string, [string, string, string]> = {
  'cache-receipt-read-error': ['apps/desktop/src/main/toolkit-receipt-store.ts', '      this.loaded = null\n      throw error', '      throw error'],
  'cache-custom-load-error': [owner, "        value.error = 'Tool receipt is unconfirmed: ' + message(error)\n        value.loading = null", "        value.error = 'Tool receipt is unconfirmed: ' + message(error)"],
  'cache-performance-load-error': ['apps/desktop/src/main/toolkit-owner.ts', '        this.loaded = null\n      }', '      }'],
  'raw-ownership': ['apps/desktop/src/main/runtime-controller.ts', "if (output === 'raw') this.toolkitRuns.set", 'if (true) this.toolkitRuns.set'],
  'repeat-load': [owner, 'const added = [...enabled].filter(id => !this.autoStartingTools.has(id))', 'const added = [...enabled]'],
  'runner-environment': [owner, '      delete env.ELECTRON_RUN_AS_NODE\n', ''],
  'skip-original-read': [owner, "let receipt = await readOriginal(action?.kind === 'release' || tool.pendingLaunch === 'retirement-unavailable' ? true : undefined)",
    "let receipt = { hostId: 'local', operationId: prepared.createOperationId, known: false, admission: null }"],
  'skip-first-failure-save': [owner, 'if (!execution.admission.run) await this.saveTuiLaunchFailure(execution)', 'void execution.admission.run'],
  'pending-release-without-proof': [owner, "if (action?.kind === 'release' && canRelease) {", "if (action?.kind === 'release') {"],
  'pending-retirement-without-fence': [owner, "if (retirement?.outcome === 'retired') {", "if (retirement?.outcome === 'retired' || action?.kind === 'cancel') {"],
  'pending-recovery-auto-start': [owner, ' || tool.manualStartRequired || tool.latest?.cancelledPendingLaunch', ''],
  'pending-recovery-missing-authority': ['packages/core/src/public-rpc-service.ts', "if (context.caller !== undefined || context.routeDelegation !== undefined || context.transport !== 'unix' ||\n              context.principal?.kind !== 'user' || context.principal.id !== `local-user:${process.getuid?.() ?? 'current'}`)", 'if (false)'],
  'missing-intent': [owner, 'const prepared = retained ? this.tuiPreparation(execution) : await execution.port.prepare', 'const prepared = await execution.port.prepare'],
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
    'apps/desktop/test/run-service-projection.test.ts', 'apps/desktop/test/toolkit-receipt-store.test.ts'] } })
