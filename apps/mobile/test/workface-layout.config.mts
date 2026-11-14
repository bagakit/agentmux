import { appendFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import base from '../vitest.config'
const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.WORKFACE_LAYOUT_MUTATION, trace = process.env.WORKFACE_LAYOUT_LOADED
const presentation = 'apps/mobile/src/layout/workface-presentation.ts'
const mutations: Record<string, { file: string; before: string; after: string; target: string }> = {
  'landscape-remains-compact': { file: presentation, before: 'MOBILE_WORKFACE_SPLIT_MIN_WIDTH = 600', after: 'MOBILE_WORKFACE_SPLIT_MIN_WIDTH = 760', target: 'workface Goal consumes the original viewport budget' },
  'inactive-erases-background': { file: presentation, before: 'const navigation = split || !hasSelection, content = split || hasSelection', after: 'const navigation = active && (split || !hasSelection), content = active && (split || hasSelection)', target: 'workface Goal consumes the original viewport budget' },
  'space-catalog-follows-hidden-navigation': { file: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', before: 'const catalogActive = panes.navigation.observed || panes.content.observed || focusActive', after: 'const catalogActive = panes.navigation.observed || focusActive', target: 'workface Space keeps the real original file' },
}
if (mutant && !mutations[mutant]) throw Error('Unknown workface layout mutation: ' + mutant)
const mutation = mutant ? mutations[mutant] : undefined
const owners = new Set([presentation, 'apps/mobile/src/layout/MobileWorkfaceFrame.tsx', 'apps/mobile/src/layout/use-mobile-workface-layout.ts',
  'apps/mobile/src/goals/MobileGoalsSurface.tsx', 'apps/mobile/src/goals/MobileGoalCreate.tsx', 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx',
  'apps/mobile/src/navigation/MobileRegionContent.tsx', 'apps/mobile/src/platform/native/device.ts', 'apps/mobile/src/MobileApp.tsx',
  'apps/mobile/test/mobile-goal-owner.test.tsx', 'apps/mobile/test/workface-layout.test.tsx', 'apps/mobile/test/native-device.test.ts',
  'apps/mobile/test/responsive-spatial-workfaces.test.tsx', 'apps/mobile/test/mobile-hidden-directory-cost.test.tsx'])
const sha = (code: string) => createHash('sha256').update(code).digest('hex')
export default { ...base, root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/workface-layout/vitest', mutant ?? 'baseline'),
  server: { fs: { allow: [root, dirname(realpathSync(resolve(root, 'node_modules')))] } },
  plugins: [...base.plugins ?? [], { name: 'evaluated-workface-layout', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    let code = source
    if (mutation?.file === file) {
      if (source.split(mutation.before).length !== 2) throw Error('Workface mutation must match exactly one production anchor: ' + mutant)
      code = source.replace(mutation.before, mutation.after)
    }
    if (!trace) return source === code ? undefined : code
    const row = { file, mutation: mutation?.file === file ? mutant : null, originalSHA256: sha(source), loadedSHA256: sha(code) }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
    return code + `\nimport {appendFileSync as __workfaceTrace} from 'node:fs';__workfaceTrace(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({phase:'evaluated',...row})+'\n')});\n`
  } }], test: { ...base.test, include: ['test/mobile-goal-owner.test.tsx', 'test/workface-layout.test.tsx', 'test/native-device.test.ts',
    'test/responsive-spatial-workfaces.test.tsx', 'test/mobile-hidden-directory-cost.test.tsx'],
    testNamePattern: mutation?.target ?? '^workface ', maxWorkers: 1, fileParallelism: false, passWithNoTests: false } }
