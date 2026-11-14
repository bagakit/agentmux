import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'

const repository = resolve(import.meta.dirname, '../../..')
const mutation = process.env.GOAL_SPACE_MUTANT ? JSON.parse(process.env.GOAL_SPACE_MUTANT) : null
const owners = new Set(['apps/desktop/src/renderer/src/components/GoalDetail.tsx', 'apps/desktop/src/renderer/src/components/GoalPlanGraph.tsx'])
export default { ...original, plugins: [...(original.plugins ?? []), {
  name: 'goal-space-loaded-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(repository, id.split('?')[0]!)
    if (!owners.has(path)) return
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const originalSHA256 = hash(source)
    if (mutation?.path === path) {
      if (source.split(mutation.anchor).length !== 2) throw Error('Mutation must identify one original owner anchor: ' + mutation.id)
      source = source.replace(mutation.anchor, () => mutation.replacement)
    }
    const output = process.env.GOAL_SPACE_LOADED
    if (!output) return source
    const row = JSON.stringify({ path, mutant: mutation?.path === path ? mutation.id : null, originalSHA256, loadedSHA256: hash(source) }) + '\n'
    return `import { appendFileSync as __goalSpaceLoaded } from 'node:fs'; __goalSpaceLoaded(${JSON.stringify(output)}, ${JSON.stringify(row)});\n` + source
  }
} ], test: { ...original.test, include: ['apps/desktop/test/goal-plan-graph.test.tsx'], passWithNoTests: false } }
