import { defineConfig } from 'vitest/config'
import { sourceAliases } from './goal-cross-host-source.mjs'
import { instrumentPlanningSource } from './goal-planning-discussion-source.mjs'
export default defineConfig({
  plugins: [{ name: 'goal-planning-original-owner', enforce: 'pre', transform(source, id) {
    const changed = instrumentPlanningSource(source, id.split('?')[0]!, 'host-core')
    return changed === source ? null : changed
  } }],
  resolve: { alias: sourceAliases.map(({ find, replacement }) => ({ find: new RegExp('^' + find.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace('*', '(.*)') + '$', 'u'), replacement: replacement.replace('*', '$1') })) },
  test: { include: ['apps/host/test/goal-discussion-intent.test.ts', 'apps/host/test/goal-planning-discussion.test.ts', 'apps/host/test/goal-first-discussion.test.ts', 'packages/core/test/goal-plan-guidance.test.ts', 'packages/demand/test/demand-discussion-provenance.test.ts'],
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 30_000, hookTimeout: 30_000 }
})
