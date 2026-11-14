import base from './hook-postcommit-observation.vitest.config.mts'
import { resolve } from 'node:path'
import { mutatePolicySource } from './fixtures/startup-policy-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default { ...base, cacheDir: resolve(root, '.local/cache/startup-policy-reevaluation'),
  resolve: { alias: [{ find: '@agentmux/identity/runtime-source', replacement: resolve(root, 'packages/identity/dist/runtime-source.js') }, ...base.resolve.alias] },
  plugins: [{ name: 'startup-policy-owner-mutation', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = id.split('?')[0]!.slice(root.length + 1)
    const code = mutatePolicySource(source, file, process.env.STARTUP_POLICY_MUTANT)
    return code === source ? undefined : { code, map: null }
  } }], test: { ...base.test, include: process.env.STARTUP_POLICY_ADJACENT ? [
      'packages/core/test/agent-session-recovery-sources.test.ts', 'packages/core/test/frontend-continuity-supervision.test.ts',
      'packages/core/test/startup-recovery-lifecycle.test.ts', 'packages/core/test/agent-session-continuity.test.ts'
    ] : ['packages/core/test/startup-policy-reevaluation.test.ts'],
    globalSetup: [], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 40_000, hookTimeout: 20_000 }
}
