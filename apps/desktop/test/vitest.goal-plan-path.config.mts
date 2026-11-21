import { defineConfig } from 'vitest/config'
import original from './vitest.goal-current-work.config.mts'

export default defineConfig({
  ...original,
  plugins: [...original.plugins ?? [], {
    name: 'goal-plan-path-mutation', enforce: 'pre', transform(source, id) {
      if (process.env.GOAL_PLAN_PATH_MUTATION === 'omit-handoff-review' && id.endsWith('/GoalPlanGraph.tsx')) {
        const conclusion = "state === 'done' ? 'Review passed'"
        if (source.split(conclusion).length !== 2) throw Error('Expected the signed Ticket verdict.')
        return source.replace(conclusion, "state === 'done' ? undefined")
      }
      if (process.env.GOAL_PLAN_PATH_MUTATION === 'reverse-handoff' && id.endsWith('/GoalPlanGraph.tsx')) {
        const direction = 'reported ? [worker, owner] : [owner, worker]'
        if (source.split(direction).length !== 2) throw Error('Expected the original task handoff.')
        return source.replace(direction, '[owner, worker]')
      }
      if (process.env.GOAL_PLAN_PATH_MUTATION === 'unchecked-success' && id.endsWith('/GoalPlanGraph.tsx')) {
        const unchecked = "Unverified: semanticIconComponent('status.unknown')"
        if (source.split(unchecked).length !== 2) throw Error('Expected the unchecked Goal finish glyph.')
        return source.replace(unchecked, "Unverified: semanticIconComponent('status.completed')")
      }
      if (process.env.GOAL_PLAN_PATH_MUTATION === 'collapse-ports' && id.endsWith('/goal-plan-routing.ts')) {
        const fanOut = 'edge[side] = center(box) + (index - (edges.length - 1) / 2) * spacing'
        if (source.split(fanOut).length !== 2) throw Error('Expected the task port allocator.')
        return source.replace(fanOut, 'edge[side] = center(box)')
      }
      if (process.env.GOAL_PLAN_PATH_MUTATION === 'wrong-reader' && id.endsWith('/GoalPlanGraph.tsx')) {
        const target = 'open ? byId.get(open) : undefined'
        if (source.split(target).length !== 2) throw Error('Expected the saved node lookup in the original workbench.')
        return source.replace(target, 'open ? projection.nodes[0] : undefined')
      }
      if (process.env.GOAL_PLAN_PATH_MUTATION !== 'reverse-child' || !id.endsWith('/useGoalPlanPath.ts')) return
      const original = 'neighbors.get(parent)?.downstream.push({ id: node.id, path })'
      if (source.split(original).length !== 2) throw Error('Expected one dependency-to-child insertion.')
      return source.replace(original, 'neighbors.get(node.id)?.downstream.push({ id: parent, path })')
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/goal-plan-path.test.tsx'], passWithNoTests: false }
})
