import original from './vitest.goal-plan-revision.config.mts'
export default { ...original, test: { ...original.test, include: ['packages/demand/test/demand-read-cost.test.ts'], passWithNoTests: false } }
