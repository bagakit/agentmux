import { appendFileSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import base from '../vitest.config'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.RESPONSIVE_GOALS_MUTATION, trace = process.env.RESPONSIVE_GOALS_LOADED
const owner = 'apps/mobile/src/goals/MobileGoalsSurface.tsx'
const variants = {
  'hide-wide-goal-list': { before: 'split: wide,', after: 'split: false,', target: 'responsive Goals actual App' },
  'remount-width-goal-editor': { before: '<GoalDetail key={id}', after: '<GoalDetail key={id + (wide ? ":wide" : ":phone")}', target: 'responsive Goals actual App' },
  'recreate-list-on-selection': { before: '[client, connected, listVisible, revision, status]', after: '[client, connected, listVisible, revision, status, selected]', target: 'responsive Goals uses only its visible original list' }
} as const
if (mutation && !Object.hasOwn(variants, mutation)) throw Error('Unknown responsive Goal mutation')
const variant = mutation ? variants[mutation as keyof typeof variants] : undefined
const files = new Set([owner, 'apps/mobile/src/goals/MobileGoalDraftEditor.tsx', 'apps/mobile/src/goals/useGoalDraft.ts', 'apps/mobile/src/MobileApp.tsx', 'apps/mobile/test/mobile-goal-owner.test.tsx'])
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/mobile-all-surfaces/goals/vitest', mutation ?? 'baseline'),
  server: { fs: { allow: [root, dirname(realpathSync(resolve(root, 'node_modules')))] } },
  plugins: [...base.plugins ?? [], { name: 'actual-responsive-goal-consumers', enforce: 'pre' as const, transform(original: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!files.has(file)) return
    let code = original
    if (variant && file === owner) {
      if (code.split(variant.before).length !== 2) throw Error('Responsive Goal mutation must match the original owner once')
      code = code.replace(variant.before, variant.after)
    }
    if (!trace) return code === original ? undefined : code
    const row = { file, originalSHA256: sha(readFileSync(resolve(root, file), 'utf8')), loadedSHA256: sha(code), mutation: variant && file === owner ? mutation : null }
    return code + `\nimport {appendFileSync as __responsiveGoalLoaded} from 'node:fs';__responsiveGoalLoaded(${JSON.stringify(resolve(root, trace))},${JSON.stringify(JSON.stringify(row)+'\n')});\n`
  } }],
  test: { ...base.test, include: ['test/mobile-goal-owner.test.tsx'], testNamePattern: variant?.target ?? '^responsive Goals', maxWorkers: 1, fileParallelism: false, passWithNoTests: false }
}
