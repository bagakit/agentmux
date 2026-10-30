import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import goals from './vitest.goals-domain.config.mjs'
import { instrumentGoalOwnerRecovery, goalOwnerRecoverySource, prepareGoalOwnerIdentity } from './goal-owner-recovery-mutations.mjs'
const root = resolve(import.meta.dirname, '../../..')
await prepareGoalOwnerIdentity(root)
export default defineConfig({ ...goals,
  plugins: [{ name: 'goal-owner-recovery-source', enforce: 'pre', resolveId(id) { return goalOwnerRecoverySource(root, id) }, transform(source, id) {
    const transformed = instrumentGoalOwnerRecovery(source, relative(root, id.split('?')[0]!), 'vitest')
    return source === transformed ? null : transformed
  } }, ...(goals.plugins ?? [])],
  resolve: { ...goals.resolve, alias: [{ find: /^@agentmux\/demand$/u, replacement: resolve(import.meta.dirname, '../../../packages/demand/src/index.ts') },
    { find: /^@agentmux\/demand\/(.+)$/u, replacement: resolve(import.meta.dirname, '../../../packages/demand/src/$1.ts') }, ...(goals.resolve!.alias as any[])] },
  test: { include: ['apps/host/test/goal-owner-recovery.test.ts', 'apps/host/test/goal-owner-changes.test.ts'], maxWorkers: 1, fileParallelism: false } })
