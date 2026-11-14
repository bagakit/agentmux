import { writeFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'
import source from './vitest.goal-plan-delivery-workflow.config.mts'
export default defineConfig({
  ...source,
  plugins: [...(source.plugins ?? []), {
    name: 'goal-node-assignment-mutation', enforce: 'pre', transform(code, id) {
      const variant = process.env.GOAL_ASSIGNMENT_MUTATION
      if (!variant || !id.endsWith('/GoalPlanAssignment.tsx')) return
      const targets: Record<string, [string, string]> = {
        'wrong-node': ['nodeId: node.id, operationId: mintObjectId()', "nodeId: 'test', operationId: mintObjectId()"],
        'keep-unsent': ["if (mode === 'submit')\n            saveDraft", 'if (false)\n            saveDraft'],
        'discard-unknown': ["if (mode === 'submit')\n            saveDraft", 'if (true)\n            saveDraft'],
        'discard-newer-attempt': ['catch (cause) {\n          if (currentDraft() !== prepared) return', 'catch (cause) {']
      }
      const [before, after] = targets[variant]!
      if (code.split(before).length !== 2) throw Error('Assignment mutation must match one exact source expression.')
      if (process.env.GOAL_ASSIGNMENT_RECOVERY_WITNESS) writeFileSync(process.env.GOAL_ASSIGNMENT_RECOVERY_WITNESS, variant)
      return code.replace(before, after)
    }
  }],
  test: { ...source.test, include: ['apps/desktop/test/goal-plan-assignment-workbench.test.tsx'] }
})
