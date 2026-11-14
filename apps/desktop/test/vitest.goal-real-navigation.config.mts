import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const owners = new Set(['apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GoalsCollection.tsx',
  'apps/desktop/src/renderer/src/components/GoalsCommonActions.tsx', 'apps/desktop/src/renderer/src/components/GlobalGoalPatrolControl.tsx',
  'apps/desktop/src/renderer/src/lib/goal-navigation.ts'])
const mutation = process.env.GOAL_NAV_MUTANT ? JSON.parse(process.env.GOAL_NAV_MUTANT) : null
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
export default { ...original, plugins: [...(original.plugins ?? []), {
  name: 'goal-navigation-loaded-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(repository, id.split('?')[0]!)
    if (!owners.has(path)) return
    const originalSHA256 = hash(source)
    if (mutation?.path === path) {
      if (source.split(mutation.anchor).length !== 2) throw Error('Mutation requires the exact navigation owner anchor: ' + mutation.id)
      source = source.replace(mutation.anchor, () => mutation.replacement)
    }
    if (process.env.GOAL_NAV_LOADED) {
      const row = JSON.stringify({ path, originalSHA256, loadedSHA256: hash(source), mutant: mutation?.path === path ? mutation.id : null }) + '\n'
      source = `import { appendFileSync as __goalNavigationLoaded } from 'node:fs'; __goalNavigationLoaded(${JSON.stringify(process.env.GOAL_NAV_LOADED)}, ${JSON.stringify(row)});\n` + source
    }
    return source
  }
}], test: { ...original.test, include: process.env.GOAL_NAV_CHROME ? ['apps/desktop/test/goals-common-actions.test.tsx', 'apps/desktop/test/goals-entry-actions.test.tsx', 'apps/desktop/test/goal-global-patrol-product.test.tsx'] : ['apps/desktop/test/goals-page-maturity.test.tsx', 'apps/desktop/test/ui-goal-view-controls.test.tsx'], passWithNoTests: false } }
