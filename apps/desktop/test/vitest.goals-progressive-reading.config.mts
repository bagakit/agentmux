import { createHash } from 'node:crypto'
import { relative } from 'node:path'
import original from './vitest.goal-current-work.config.mts'

const owners = ['GoalResponsibilitySummary', 'GoalsCollection'].map(name => `apps/desktop/src/renderer/src/components/${name}.tsx`)
const mutations = {
  'expanded-diagnostics': [owners[0], '<details className="goal-responsibility-preview"', '<details open className="goal-responsibility-preview"'],
  'empty-lanes': [owners[1], '{occupied.map(status =>', '{visibleStatuses.map(status =>'],
  'select-on-read': [owners[0], 'onClick={event => event.stopPropagation()}\n    onKeyDown=', 'onClick={() => {}}\n    onKeyDown=']
} as const
const mutation = process.env.GOAL_PROGRESSIVE_MUTATION as keyof typeof mutations | undefined
if (mutation && !mutations[mutation]) throw Error('Unknown progressive reading mutation')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...original, plugins: [...original.plugins ?? [], { name: 'actual-goal-progressive-reading', enforce: 'pre' as const, transform(source: string, id: string) {
  const file = relative(process.cwd(), id.split('?')[0]!)
  if (!owners.includes(file)) return
  const originalSHA256 = hash(source)
  if (mutation && mutations[mutation][0] === file) {
    const [, anchor, replacement] = mutations[mutation]
    if (source.split(anchor).length !== 2) throw Error('Progressive reading mutation requires one exact production anchor')
    source = source.replace(anchor, replacement)
  }
  const row = { file, originalSHA256, loadedSHA256: hash(source), mutation: mutation && mutations[mutation][0] === file ? mutation : null }
  const output = process.env.GOAL_PROGRESSIVE_LOADED
  return output ? `import {appendFileSync as __progressiveLoaded} from 'node:fs';__progressiveLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source : source
} }], test: { ...original.test, include: ['apps/desktop/test/goals-progressive-reading.test.tsx'], passWithNoTests: false } }
