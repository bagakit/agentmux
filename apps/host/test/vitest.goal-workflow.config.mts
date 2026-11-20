import { defineConfig } from 'vitest/config'
import original from './vitest.goal-cross-host.config.mts'

const mutation = process.env.GOAL_WORKFLOW_REVIEW_MUTATION
if (mutation && mutation !== 'skip-input' && mutation !== 'skip-release-hint') throw Error('Unknown workflow review mutation')
export default defineConfig({
  ...original,
  plugins: [{
    name: 'goal-workflow-review-mutation',
    enforce: 'pre',
    transform(source, id) {
      const file = id.split('?')[0]!
      const anchor = mutation === 'skip-input' && file.endsWith('/apps/host/src/goal-workflow-review.ts')
        ? 'if (claim.replayed) return'
        : mutation === 'skip-release-hint' && file.endsWith('/apps/host/src/goal-delegation-owner.ts')
          ? "passRecorded = review.verdict === 'pass' && receipt.replayed !== true" : undefined
      if (!anchor) return null
      if (source.split(anchor).length !== 2) throw Error('Workflow review mutation must match exactly one original gate')
      return source.replace(anchor, mutation === 'skip-input' ? 'return' : 'passRecorded = false')
    }
  }, ...(original.plugins ?? [])],
  test: { ...original.test, include: ['apps/host/test/goal-workflow-review.test.ts'], passWithNoTests: false }
})
