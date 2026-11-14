import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import original from './vitest.goals-workflow.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const owners = ['components/GoalPlanRequest.tsx', 'components/GoalProperties.tsx', 'lib/goal-discussion-recipient.ts', 'lib/session-presentation.ts']
  .map(path => 'apps/desktop/src/renderer/src/' + path)
const mutation = process.env.GOAL_CONSUMER_MUTATION ? JSON.parse(process.env.GOAL_CONSUMER_MUTATION) : null
export default { ...original, plugins: [...original.plugins ?? [], {
  name: 'goal-related-consumer-owner', enforce: 'pre' as const, transform(source: string, id: string) {
    const path = relative(root, id.split('?')[0]!)
    if (!owners.includes(path)) return
    const hash = (text: string) => createHash('sha256').update(text).digest('hex'), originalSHA256 = hash(source)
    if (mutation?.path === path) {
      if (source.split(mutation.anchor).length !== 2) throw new Error('A consumer mutation must replace one exact owner segment')
      source = source.replace(mutation.anchor, () => mutation.replacement)
    }
    const output = process.env.GOAL_CONSUMER_LOADED
    if (!output) return source
    appendFileSync(output, '')
    const row = { path, originalSHA256, loadedSHA256: hash(source), ...(mutation?.path === path ? { mutant: mutation.id } : {}) }
    return `import {appendFileSync as __consumerLoaded} from 'node:fs'; __consumerLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-related-consumer-cost.test.tsx'], passWithNoTests: false } }
