import { defineConfig } from 'vitest/config'
import original from './vitest.goal-cross-host.config.mts'

const mutation = process.env.GOAL_WORKFLOW_REVIEW_MUTATION
if (mutation && mutation !== 'skip-input') throw Error('Unknown workflow review mutation')
export default defineConfig({
  ...original,
  plugins: [{
    name: 'goal-workflow-review-mutation',
    enforce: 'pre',
    transform(source, id) {
      if (!mutation || !id.split('?')[0]!.endsWith('/apps/host/src/goal-workflow-review.ts')) return null
      const anchor = 'if (claim.replayed) return'
      if (source.split(anchor).length !== 2) throw Error('Workflow review mutation must match one exact input gate')
      return source.replace(anchor, 'return')
    }
  }, ...(original.plugins ?? [])],
  test: { ...original.test, include: ['apps/host/test/goal-workflow-review.test.ts'], passWithNoTests: false }
})
