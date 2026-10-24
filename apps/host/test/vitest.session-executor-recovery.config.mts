import { relative, resolve } from 'node:path'
import base from '../../../packages/core/test/hook-postcommit-observation.vitest.config.mts'
import { instrumentExecutorRecovery } from './session-executor-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
export default { ...base, resolve: { ...base.resolve, alias: [
  { find: /^@agentmux\/identity\/runtime-source$/u, replacement: resolve(root, 'packages/identity/dist/runtime-source.js') },
  ...(base.resolve?.alias as Array<{ find: string | RegExp; replacement: string }> ?? [])
] }, plugins: [{ name: 'original-session-executor-recovery', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const changed = instrumentExecutorRecovery(source, relative(root, id.split('?')[0]!), 'vitest-transform')
    return changed === source ? null : changed
  } }], test: { ...base.test, root, include: ['packages/core/test/session-continuity-executor.test.ts', 'apps/host/test/session-executor-recovery.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 60_000, hookTimeout: 30_000 } }
