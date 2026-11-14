import original from './vitest.goal-current-work.config.mts'

// One real workspace and its original Host work; unrelated suites do not enter this proof.
export default { ...original, test: { ...original.test, include: [
  'apps/desktop/test/goal-plan-graph.test.tsx',
  'apps/desktop/test/goal-current-work-report-product.test.tsx'
], passWithNoTests: false } }
