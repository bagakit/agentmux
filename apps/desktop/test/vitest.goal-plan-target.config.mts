import original from './vitest.goal-plan-request.config.mts'
export default { ...original, test: { ...original.test, include: ['apps/desktop/test/goal-plan-discovery-product.test.tsx'] } }
