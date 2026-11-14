import { appendFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import base from '../vitest.config'
const root = resolve(import.meta.dirname, '../../..'), variant = process.env.WIDE_WORKFACE_MUTATION, trace = process.env.WIDE_WORKFACE_LOADED
const mutations: Record<string, { before: string; after: string; target: string }> = {
  'hide-wide-focus': { before: 'const focusShown = focusRoot || wideWorkface && !sidebarCollapsed', after: 'const focusShown = focusRoot', target: 'wide sidebar shows the original Focus' },
  'remount-width-editor': { before: '<MobileConversationSurface client={client}', after: '<MobileConversationSurface key={wideWorkface ? "wide" : "compact"} client={client}', target: 'wide rotation retains the same editor' },
  'duplicate-catalog-reader': { before: 'directoryVisible || focusVisible || !exposed)', after: 'directoryVisible || !exposed)', target: 'wide directory 20 uses one catalog owner' }
}
if (variant && !mutations[variant]) throw Error('Unknown wide workface mutation: ' + variant)
const mutation = variant ? mutations[variant] : undefined
const owners = new Set(['apps/mobile/src/MobileApp.tsx', 'apps/mobile/src/navigation/defer-mobile-surface.tsx', 'apps/mobile/test/wide-agent-directory-load.test.tsx', 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', 'apps/mobile/src/navigation/MobileAgentRow.tsx', 'apps/mobile/src/layout/use-mobile-workface-layout.ts', 'apps/mobile/src/layout/workface-presentation.ts', 'apps/mobile/src/platform/native/device.ts', 'apps/mobile/src/conversation/MobileConversationSurface.tsx', 'apps/mobile/test/wide-agent-workface.test.tsx', 'apps/mobile/test/mobile-hidden-directory-cost.test.tsx'])
const sha = (source: string) => createHash('sha256').update(source).digest('hex')
export default { ...base, root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/mobile-wide-agent-workface/vitest', variant ?? 'baseline'),
  server: { fs: { allow: [root, dirname(realpathSync(resolve(root, 'node_modules')))] } },
  plugins: [...base.plugins ?? [], { name: 'evaluated-wide-workface', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    let code = source
    if (mutation && file === 'apps/mobile/src/MobileApp.tsx') {
      if (source.split(mutation.before).length !== 2) throw Error('Wide mutation must match the actual owner once: ' + variant)
      code = code.replace(mutation.before, mutation.after)
    }
    if (!trace) return code === source ? undefined : code
    const row = { file, mutation: code !== source ? variant : null, originalSHA256: sha(source), loadedSHA256: sha(code) }
    appendFileSync(trace, JSON.stringify({ phase: 'loaded', ...row }) + '\n')
    return code + `\nimport {appendFileSync as __wideTrace} from 'node:fs';__wideTrace(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({phase:'evaluated',...row})+'\n')});\n`
  } }],
  test: { ...base.test, include: ['test/wide-agent-workface.test.tsx', 'test/mobile-hidden-directory-cost.test.tsx', 'test/wide-agent-directory-load.test.tsx'], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, ...(mutation ? { testNamePattern: mutation.target } : {}) }
}
