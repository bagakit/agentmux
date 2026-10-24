import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'

const mutant = process.env.AGENTMUX_STARTUP_DIAGNOSTIC_MUTANT
const mutations: Record<string, [string, string, string]> = {
  'drop-record': ['client.ts', 'this.startupDiagnostics.observe(this.registry.get(session.agentSessionId), observation)', 'void observation'],
  'wrong-run': ['client.ts', 'this.startupDiagnostics.observe(this.registry.get(session.agentSessionId), observation)', "this.startupDiagnostics.observe({ ...this.registry.get(session.agentSessionId), run: { runId: 'mutant-wrong-run' } }, observation)"],
  'lose-zero': ['startup-diagnostic.ts', 'return typeof value === \'number\' && Number.isSafeInteger(value) ? value : diagnosticCauseCode(value)', "return value === 0 ? null : typeof value === 'number' && Number.isSafeInteger(value) ? value : diagnosticCauseCode(value)"],
  'private-leak': ['startup-diagnostic-journal.ts', 'original: includeRaw ? structuredClone(record.original) : null', 'original: structuredClone(record.original)'],
}
export default defineConfig({ root: resolve(import.meta.dirname, '../../..'), plugins: [{ name: 'startup-diagnostic-loaded-owner', enforce: 'pre',
  transform(input, id) {
    if (!/\/packages\/core\/src\/(client|startup-diagnostic|startup-diagnostic-journal)\.ts$/u.test(id)) return
    let code = input
    if (mutant && mutations[mutant]?.[0] === id.split('/').at(-1)) {
      const [, from, to] = mutations[mutant]!
      if (!code.includes(from)) throw new Error(`Startup mutation did not reach its loaded owner: ${mutant}`)
      code = code.replace(from, to)
    }
    if (process.env.AGENTMUX_STARTUP_DIAGNOSTIC_LOADED) appendFileSync(process.env.AGENTMUX_STARTUP_DIAGNOSTIC_LOADED,
      JSON.stringify({ path: id, originalSHA256: createHash('sha256').update(input).digest('hex'), loadedSHA256: createHash('sha256').update(code).digest('hex'), mutant: mutant ?? null }) + '\n')
    return code === input ? undefined : { code, map: null }
  }
}], test: { environment: 'node', globalSetup: [], passWithNoTests: false, fileParallelism: false, maxWorkers: 1,
  include: ['packages/core/test/startup-diagnostics.test.ts', 'packages/core/test/startup-diagnostics-public.integration.test.ts', 'packages/core/test/diagnostic-evidence.test.ts'],
  env: { AGENTMUX_TEST_OWNER_ENTRY: resolve(import.meta.dirname, 'fixtures/frontend-recovery-owner.mjs') },
  testTimeout: 60_000, hookTimeout: 30_000
} })
