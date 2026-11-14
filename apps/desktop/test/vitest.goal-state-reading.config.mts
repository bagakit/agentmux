import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'
const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.GOAL_STATE_READING_MUTANT ? JSON.parse(process.env.GOAL_STATE_READING_MUTANT) : undefined
export default { ...original, plugins: [...(original.plugins ?? []), { name: 'goal-state-reading-source-owner', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    const originalSHA256 = hash(source)
    if (mutation?.path === path) {
      if (source.split(mutation.anchor).length !== 2) throw Error('A semantic mutation must name one exact owner')
      source = source.replace(mutation.anchor, mutation.replacement)
    }
    if (path === 'apps/desktop/src/renderer/src/store.ts') source = source.replaceAll('__AGENTMUX_WEB_PREVIEW__', 'false')
    if (mutation?.path !== path || !process.env.GOAL_STATE_READING_LOADED) return source
    const row = { mutation: mutation.id, path, originalSHA256, loadedSHA256: hash(source) }
    return `import { appendFileSync as __stateReadingLoaded } from 'node:fs'; __stateReadingLoaded(${JSON.stringify(process.env.GOAL_STATE_READING_LOADED)}, ${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-plan-state-reading.test.tsx', 'packages/core/test/goal-plan-state.test.ts', 'packages/core/test/goal-plan-guidance.test.ts', 'packages/demand/test/goal-plan.test.ts', 'packages/demand/test/goal-plan-revision.test.ts'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 60_000, hookTimeout: 60_000 } }
