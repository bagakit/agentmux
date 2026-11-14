import { resolve } from 'node:path'
import base from './vitest.goal-current-work.config.mts'

const consumer = resolve(import.meta.dirname, '../src/renderer/src/components/GlobalBoardSurface.tsx')
const original = 'const columns = useMemo(() => demandColumns(visibleDemands), [visibleDemands])'
export default {
  ...base,
  plugins: [...base.plugins ?? [], {
    name: 'goals-workflow-board-consumer-mutation',
    enforce: 'pre' as const,
    transform(source: string, id: string) {
      if (process.env.GOALS_WORKFLOW_MUTATION !== 'ignore-stage' || id.split('?')[0] !== consumer) return
      if (source.split(original).length !== 2) throw new Error('Expected exactly one Goals board column consumer')
      return source.replace(original, 'const columns = useMemo(() => demandColumns(filteredDemands), [filteredDemands])')
    }
  }],
  test: { ...base.test, include: ['apps/desktop/test/goal-workflow-filter.test.tsx'], passWithNoTests: false }
}
