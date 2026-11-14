import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import original from './vitest.goal-current-work.config.mts'
const board = 'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx'
const common = 'apps/desktop/src/renderer/src/components/GoalsCommonActions.tsx'
const mutations = {
  'separate-common': [board, '        <GoalsCommonActions contextCompact={Boolean(selectedDemandId)} onReturnToCommon={() => setSelectedDemand(null)} />\n      </header>', '      </header>\n      <GoalsCommonActions contextCompact={Boolean(selectedDemandId)} onReturnToCommon={() => setSelectedDemand(null)} />'],
  'replace-common': [board, '<GoalsCommonActions contextCompact=', '<GoalsCommonActions key={selectedDemandId ?? "collection"} contextCompact='],
  'lose-save-feedback': [common, '{saveError ? <p className="goals-service"', '{false ? <p className="goals-service"']
} as const
const mutation = process.env.GOALS_START_MUTATION as keyof typeof mutations | undefined
if (mutation && !mutations[mutation]) throw Error('Unknown start-area mutation')
const hash = (source: string) => createHash('sha256').update(source).digest('hex')
export default { ...original, plugins: [...original.plugins ?? [], { name: 'actual-goals-start-area', enforce: 'pre' as const, transform(source: string, id: string) {
  const file = relative(process.cwd(), id.split('?')[0]!)
  if (![board, common].includes(file)) return
  const originalSHA256 = hash(source)
  if (mutation && mutations[mutation][0] === file) {
    const [, anchor, replacement] = mutations[mutation]
    if (source.split(anchor).length !== 2) throw Error('One actual source anchor required')
    source = source.replace(anchor, replacement)
  }
  const output = process.env.GOALS_START_LOADED
  if (output) appendFileSync(output, JSON.stringify({ file, originalSHA256, loadedSHA256: hash(source), mutation: mutation && mutations[mutation][0] === file ? mutation : null }) + '\n')
  return source
} }], test: { ...original.test, include: ['apps/desktop/test/goals-start-area.test.tsx'], passWithNoTests: false } }
