import original from './vitest.goals-workflow.config.mts'
export default { ...original, test: { ...original.test, include: [
  'apps/desktop/test/host-message-trust.test.tsx', 'apps/desktop/test/host-creation-trust.test.tsx',
  'apps/desktop/test/goal-plan-graph.test.tsx', 'apps/desktop/test/goal-delegation-work.test.tsx'
], passWithNoTests: false, maxWorkers: 1, fileParallelism: false } }
