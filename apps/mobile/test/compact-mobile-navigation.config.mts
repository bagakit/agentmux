import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from '../vitest.config'
const root = resolve(import.meta.dirname, '../../..'), variant = process.env.COMPACT_NAV_MUTATION, trace = process.env.COMPACT_NAV_LOADED
const mutations: Record<string, { file: string; before: string; after: string; target: string }> = {
  'back-narrow-shell': { file: 'apps/mobile/src/MobileApp.tsx', before: 'const wideShell = wideViewport && workspaceVisible', after: 'const wideShell = wideViewport && workspaceVisible && showSession', target: 'compact wide shell remains wide after Back' },
  'avatar-color-dot': { file: 'apps/mobile/src/navigation/MobileAgentRow.tsx', before: '<FocusStateMark kind={state} presenceUnknown={presentation?.presenceUnknown} />', after: '<span className="mobile-row-dot" data-mark={state} />', target: 'compact row keeps title alone' },
  'missing-position-menu': { file: 'apps/mobile/src/MobileApp.tsx', before: '{menuTarget.location && <MobileAgentLocations', after: '{false && menuTarget.location && <MobileAgentLocations', target: 'compact More keeps the original location chooser' }
}
if (variant && !mutations[variant]) throw Error('Unknown compact navigation mutation: ' + variant)
const mutation = variant ? mutations[variant] : undefined
const owners = new Set(['apps/mobile/src/navigation/mobile-agent-locations.ts', 'apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/navigation/MobileAgentRow.tsx', 'apps/mobile/src/navigation/MobileAgentLocations.tsx', 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', 'apps/mobile/src/navigation/MobileZoneWorkface.tsx', 'apps/mobile/test/compact-mobile-navigation.test.tsx', 'apps/mobile/test/mobile-agent-locations.test.tsx', 'apps/mobile/test/wide-agent-workface.test.tsx', 'apps/mobile/test/mobile-hidden-directory-cost.test.tsx'])
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/compact-mobile-navigation/vitest', variant ?? 'baseline'),
  plugins: [...base.plugins ?? [], { name: 'evaluated-compact-navigation', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    let code = source
    if (mutation?.file === file) { if (source.split(mutation.before).length !== 2) throw Error('Compact mutation must match one original owner: ' + variant); code = code.replace(mutation.before, mutation.after) }
    if (!trace) return code === source ? undefined : code
    const row = { file, mutation: code !== source ? variant : null, originalSHA256: hash(source), loadedSHA256: hash(code) }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
    return code + `\nimport {appendFileSync as __compactTrace} from 'node:fs';__compactTrace(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({phase:'evaluated',...row})+'\n')});\n`
  } }], test: { ...base.test, include: ['test/compact-mobile-navigation.test.tsx', 'test/mobile-agent-locations.test.tsx', 'test/wide-agent-workface.test.tsx', 'test/mobile-hidden-directory-cost.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, ...(mutation ? { testNamePattern: mutation.target } : {}) }
}
