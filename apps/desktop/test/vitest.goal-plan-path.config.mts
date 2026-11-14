import { defineConfig } from 'vitest/config'
import original from './vitest.goal-current-work.config.mts'

export default defineConfig({
  ...original,
  plugins: [...original.plugins ?? [], {
    name: 'goal-plan-path-mutation', enforce: 'pre', transform(source, id) {
      if (process.env.GOAL_PLAN_PATH_MUTATION !== 'reverse-child' || !id.endsWith('/useGoalPlanPath.ts')) return
      const original = 'neighbors.get(parent)?.downstream.push({ id: node.id, path })'
      if (source.split(original).length !== 2) throw Error('Expected one dependency-to-child insertion.')
      return source.replace(original, 'neighbors.get(node.id)?.downstream.push({ id: parent, path })')
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/goal-plan-path.test.tsx'], passWithNoTests: false }
})
