import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import original from './vitest.goal-current-work.config.mts'

const owner = 'apps/desktop/src/renderer/src/components/GoalDetail.tsx'
const outline = 'apps/desktop/src/renderer/src/components/GoalReadingOutline.tsx'
const mutation = process.env.GOAL_DETAIL_READING_MUTATION || null
const mutations = {
  'manual-reading': ["detail.addEventListener('scroll', scheduleReadingSection, { passive: true })", "detail.addEventListener('unused-scroll', scheduleReadingSection, { passive: true })"],
  'selected-reading': ["aria-current={here ? 'location' : undefined}", 'aria-current={undefined}'],
  'wrong-destination': ["readingTargets[id].current", "id === 'overview' ? planRef.current : readingTargets[id].current"],
  'orphaned-discussion': ['className="goals-section-heading goals-detail__overview-heading"', 'className="goals-section-heading"'],
  'properties-disclosure': ['<details className="goals-detail__properties"', '<details open className="goals-detail__properties"']
} as const
const mutationOwner = mutation === 'selected-reading' ? outline : owner
if (mutation && !(mutation in mutations)) throw Error('Unknown detail reading mutation')
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
// Bind only the bridge segments relevant to this reading change; unrelated Store/peer work is outside this proof.
const segments: Record<string, [string, string]> = {
  'apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx': ['{selectedDemand ? <GoalDetail', '/> : selectedDemandId'],
  'apps/desktop/src/renderer/src/components/GoalWorkArea.tsx': ['    <GoalDelegationWork', 'onRevealResults={onRevealResults} />'],
  'apps/desktop/src/renderer/src/components/GoalDelegationWork.tsx': ['const recordNodes = embedded ?', '    ...records.filter(record => record.key === focusedKey)']
}
const full = [owner, outline, 'apps/desktop/src/renderer/src/components/GoalProperties.tsx', 'apps/desktop/src/renderer/src/lib/goal-edit-drafts.ts', 'apps/desktop/src/renderer/src/styles/goal-reading.css']
export default { ...original, plugins: [...original.plugins ?? [], {
  name: 'actual-goal-detail-reading', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!full.includes(file) && !segments[file]) return
    const originalSHA256 = sha(source)
    let boundSource: string | undefined
    if (segments[file]) {
      const [start, end] = segments[file]!
      if (source.split(start).length !== 2 || source.split(end).length !== 2) throw Error('Detail source bridge must be unique: ' + file)
      boundSource = source.slice(source.indexOf(start), source.indexOf(end) + end.length)
    }
    if (file === mutationOwner && mutation) {
      const [anchor, replacement] = mutations[mutation as keyof typeof mutations]
      if (source.split(anchor).length !== 2) throw Error('Detail reading mutation needs one exact production anchor')
      source = source.replace(anchor, replacement)
    }
    const output = process.env.GOAL_DETAIL_READING_LOADED
    if (!output) return source
    const row = { file, originalSHA256, loadedSHA256: sha(source), mutation: file === mutationOwner ? mutation ?? null : null, ...(boundSource ? { boundSource, boundSHA256: sha(boundSource) } : {}) }
    if (file.endsWith('.css')) { appendFileSync(output, JSON.stringify({ ...row, phase: 'style-transform' }) + '\n'); return }
    return `import {appendFileSync as __detailReadingLoaded} from 'node:fs';__detailReadingLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-detail-reading.test.tsx'], passWithNoTests: false } }
