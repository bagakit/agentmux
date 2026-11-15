import { resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'

const owner = resolve(import.meta.dirname, '../../host/src/goal-patrol-owner.ts')
export default { ...original,
  plugins: [...original.plugins ?? [], { name: 'actual-goal-confirmation-admission', enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (!process.env.GOAL_CONFIRMATION_DROP_NOTICE || id.split('?')[0] !== owner) return
      const guard = "if (patrol.purpose === 'confirmation') {\n      if (goal.status"
      if (source.split(guard).length !== 2) throw Error('Expected one actual Goal confirmation admission')
      return source.replace(guard, "if (patrol.purpose === 'confirmation') return\n    if (patrol.purpose === 'confirmation') {\n      if (goal.status")
    }
  }],
  test: { ...original.test, include: ['apps/desktop/test/goal-confirm-and-continue-product.test.tsx', 'apps/desktop/test/goal-patrol.test.ts'],
    sequence: { ...original.test?.sequence, hooks: 'stack' }, passWithNoTests: false }
}
