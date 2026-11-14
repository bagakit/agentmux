import { appendFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import type { UserConfig } from 'vitest/config'
import base from '../vitest.config'
const root = resolve(import.meta.dirname, '../../..'), variant = process.env.RESPONSIVE_SPATIAL_MUTATION, trace = process.env.RESPONSIVE_SPATIAL_LOADED
const spatial = 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx'
const mutations: Record<string, { file: string; before: string; after: string; target: string }> = {
  'space-navigation-lost': { file: spatial, before: 'presentation={panes.navigation}', after: 'presentation={{ ...panes.navigation, presented: !context.regionId }}', target: 'responsive Space keeps its original tree' },
  'space-reader-remount': { file: spatial, before: '<div key={target.key} hidden={home', after: '<div key={target.key + String(wide)} hidden={home', target: 'responsive Space keeps its original tree' },
  'focus-project-remount': { file: spatial, before: '<div className="mobile-focus-projects">', after: '<div key={String(wide)} className="mobile-focus-projects">', target: 'responsive Focus keeps 20 original project rows' },
  'foreign-file-receipt': { file: 'apps/mobile/src/navigation/MobileRegionContent.tsx', before: 'if (!confirmsOriginalResource(result.resource, params, file.path, previous?.read.resource))', after: 'if (false)', target: 'responsive Space preserves the exact original binding' }
}
if (variant && !mutations[variant]) throw Error('Unknown responsive Spatial mutation: ' + variant)
const mutation = variant ? mutations[variant] : undefined
const owners = new Set([spatial, 'apps/mobile/src/navigation/MobileSpaceDirectory.tsx', 'apps/mobile/src/navigation/MobileRegionContent.tsx', 'apps/mobile/src/MobileApp.tsx', 'apps/mobile/test/responsive-spatial-workfaces.test.tsx'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const config: UserConfig = { ...base, root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/responsive-spatial-workfaces/vitest', variant ?? 'baseline'),
  server: { fs: { allow: [root, dirname(realpathSync(resolve(root, 'node_modules')))] } },
  plugins: [...base.plugins ?? [], { name: 'evaluated-responsive-spatial-workfaces', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    let code = source
    if (mutation?.file === file) { if (source.split(mutation.before).length !== 2) throw Error('Responsive Spatial mutation must match one owner: ' + variant); code = code.replace(mutation.before, mutation.after) }
    if (!trace) return code === source ? undefined : code
    const row = { file, mutation: code !== source ? variant : null, originalSHA256: hash(source), loadedSHA256: hash(code) }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
    return code + `\nimport {appendFileSync as __spatialTrace} from 'node:fs';__spatialTrace(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row })+'\n')});\n`
  } }], test: { ...base.test, include: ['test/responsive-spatial-workfaces.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, ...(mutation ? { testNamePattern: mutation.target } : {}) }
}
export default config
