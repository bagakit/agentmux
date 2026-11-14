import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'
const repository = resolve(import.meta.dirname, '../../..')
const owners = new Set(['apps/desktop/src/renderer/src/components/GoalExecution.tsx', 'apps/desktop/src/renderer/src/lib/goal-team.ts',
  'apps/desktop/src/renderer/src/lib/goal-agent-selection.ts', 'apps/desktop/src/renderer/src/components/FocusContextCardBody.tsx',
  'apps/desktop/src/renderer/src/components/FocusContextRow.tsx', 'apps/desktop/src/renderer/src/components/GoalDetail.tsx',
  'apps/desktop/src/renderer/src/components/GoalContinuationControl.tsx'])
const mutation = process.env.GOAL_TEAM_MUTANT ? JSON.parse(process.env.GOAL_TEAM_MUTANT) : null
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
export default { ...original, plugins: [...(original.plugins ?? []), {
  name: 'goal-team-loaded-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    if (id.includes('?')) return
    const path = relative(repository, id)
    if (!owners.has(path)) return
    const originalSHA256 = hash(source)
    if (mutation?.path === path) {
      if (source.split(mutation.anchor).length !== 2) throw Error('The exact original Team owner anchor is required: ' + mutation.id)
      source = source.replace(mutation.anchor, () => mutation.replacement)
    }
    if (process.env.GOAL_TEAM_LOADED) {
      const row = JSON.stringify({ path, originalSHA256, loadedSHA256: hash(source), mutant: mutation?.path === path ? mutation.id : null }) + '\n'
      source = `import { appendFileSync as __teamLoaded } from 'node:fs'; __teamLoaded(${JSON.stringify(process.env.GOAL_TEAM_LOADED)}, ${JSON.stringify(row)});\n` + source
    }
    return source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-team-focus-card.test.tsx', 'apps/desktop/test/goal-agent-work-modes.test.tsx', 'apps/desktop/test/global-board-demand-workspace.test.tsx'], passWithNoTests: false } }
