import { defineConfig } from 'vitest/config'
import source from './vitest.goal-plan-delivery-workflow.config.mts'
export default defineConfig({
  ...source,
  plugins: [...(source.plugins ?? []), {
    name: 'goal-node-assignment-mutation', enforce: 'pre', transform(code, id) {
      if (process.env.GOAL_ASSIGNMENT_MUTATION !== 'wrong-node' || !id.endsWith('/GoalPlanAssignment.tsx')) return
      const original = 'nodeId: node.id, operationId: mintObjectId()'
      if (!code.includes(original)) throw Error('Assignment mutation did not reach its original target.')
      return code.replace(original, "nodeId: 'test', operationId: mintObjectId()")
    }
  }],
  test: { ...source.test, include: ['apps/desktop/test/goal-plan-assignment-workbench.test.tsx'] }
})
