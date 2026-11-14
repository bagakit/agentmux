import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import original from './vitest.goal-current-work.config.mts'

const owner = 'apps/desktop/src/renderer/src/components/GoalAlignment.tsx'
const mutation = process.env.GOAL_REVIEW_READING_MUTATION || null
const mutations = {
  'duplicate-current': ['const currentReport = Boolean(alignment && grounding && !stale)', 'const currentReport = false'],
  'discard-extra': ['const extraChecks = grounding?.checks.filter(check => !criterionIds.has(check.criterionId)) ?? []', 'const extraChecks = []'],
  'compact-lost': ["const compactAgreement = Boolean(alignment?.confirmedAt && !confirmIssue && !grounding && demand.status !== 'done' && !failure)", 'const compactAgreement = false'],
  'old-report-lost': ['{grounding && !currentReport ? report :', '{grounding && !currentReport && !stale ? report :'],
  'expand-report-automatically': ['<details className={`goal-review__disclosure${stale', '<details open className={`goal-review__disclosure${stale'],
  'done-hidden': ["demand.status !== 'done' && !failure)", '!failure)'],
  'recovery-hidden': ['return failure ? <div className="goals-service" role="status" data-goal-acknowledgement-failure>', 'return false ? <div className="goals-service" role="status" data-goal-acknowledgement-failure>'],
  'continued-actions-hidden': ['      </div></details>\n      {compactAgreement ? noResults : null}', '      {compactAgreement ? noResults : null}\n      </div></details>']
} as const
if (mutation && !(mutation in mutations)) throw Error('Unknown Goal review reading mutation')
const full = [owner, 'apps/desktop/src/renderer/src/components/GoalEvidence.tsx', 'apps/desktop/src/renderer/src/styles/goal-review.css']
const consumers = ['apps/desktop/src/renderer/src/components/GlobalBoardSurface.tsx', 'apps/desktop/src/renderer/src/components/GoalDetail.tsx']
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default { ...original, plugins: [...original.plugins ?? [], {
  name: 'actual-goal-review-reading', enforce: 'pre' as const,
  transform(source: string, id: string) {
    const file = relative(process.cwd(), id.split('?')[0]!)
    if (!full.includes(file) && !consumers.includes(file)) return
    const originalSHA256 = sha(source)
    if (file === owner && mutation) {
      const [anchor, replacement] = mutations[mutation as keyof typeof mutations]
      if (source.split(anchor).length !== 2) throw Error('Goal review mutation needs one actual source anchor')
      source = source.replace(anchor, replacement)
    }
    const output = process.env.GOAL_REVIEW_READING_LOADED
    if (!output) return source
    const consumer = file.endsWith('/GlobalBoardSurface.tsx') ? 'GoalDetail' : file.endsWith('/GoalDetail.tsx') ? 'GoalAlignment' : null
    const calls = consumer ? source.match(new RegExp(`<${consumer}\\b[\\s\\S]*?/>`, 'g')) : null
    if (consumer && calls?.length !== 1) throw Error('One exact mounted Goal review consumer is required: ' + file)
    const row = { file, originalSHA256, loadedSHA256: sha(source), mutation: file === owner ? mutation : null, ...(calls ? { boundSource: calls[0], boundSHA256: sha(calls[0]!) } : {}), boundary: consumers.includes(file) ? 'Actual mounted consumer call only; unrelated Root UI source is outside this component slice.' : 'Owned reading implementation or unchanged original evidence consumer.' }
    if (file.endsWith('.css')) { appendFileSync(output, JSON.stringify({ ...row, phase: 'style-transform' }) + '\n'); return }
    return `import {appendFileSync as __goalReviewLoaded} from 'node:fs';__goalReviewLoaded(${JSON.stringify(output)},${JSON.stringify(JSON.stringify(row) + '\n')});\n` + source
  }
}], test: { ...original.test, include: ['apps/desktop/test/goal-review-reading.test.tsx'], passWithNoTests: false } }
