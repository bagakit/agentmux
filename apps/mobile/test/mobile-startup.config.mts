import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import base from './mobile-web.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutant = process.env.MOBILE_STARTUP_MUTANT, trace = process.env.MOBILE_STARTUP_TRACE
const connection = 'apps/mobile/src/connection/MobileConnectionRoot.tsx'
const variants: Record<string, { before: string; after: string; target: string }> = {
  'connection-awaits-product': { before: 'working = true\n      try {', after: 'working = true\n      await prepareMobileApp()\n      try {', target: '^actual main starts its saved connection' },
  'update-before-module-ready': { before: 'const module = await prepareMobileApp().catch(() => null)', after: 'const module = true', target: '^actual main waits for the real product module' },
  'metadata-cancel-does-not-abort': { before: '      metadata.abort()', after: '      void 0', target: '^actual main cancels only pending metadata and rereads its original pin while old success' },
  'late-metadata-clears-new-observation': { before: 'if (!controller.signal.aborted && cancelMetadata.current === cancelObservation)', after: 'if (true)', target: '^actual main cancels only pending metadata and rereads its original pin while old success' },
}
if (mutant && !variants[mutant]) throw Error('Unknown startup mutation: ' + mutant)
const mutation = mutant ? variants[mutant] : null
const owners = new Set([connection, 'apps/mobile/src/connection/prepare-mobile-app.ts', 'apps/mobile/src/main.tsx', 'apps/mobile/src/MobileApp.tsx',
  'apps/mobile/src/navigation/defer-mobile-surface.tsx', 'apps/mobile/src/recovery/device-storage-lock.ts', 'apps/mobile/src/recovery/device-workface.ts', 'apps/mobile/src/recovery/workface.ts',
  'apps/mobile/test/mobile-startup.test.tsx', 'apps/mobile/test/mobile-update-workface.test.tsx', 'apps/mobile/test/mobile-update-connection.test.tsx', 'apps/mobile/test/short-connection-entry.test.tsx'])
export default { ...base, define: { ...base.define, __AGENTMUX_MOBILE_BUILD_ID__: JSON.stringify('short-page-build') }, cacheDir: resolve(root, '.tmp/mobile-loading-review/vitest', mutant ?? 'normal'), plugins: [...base.plugins ?? [], {
  name: 'evaluated-mobile-startup', enforce: 'pre' as const, transform(original: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file)) return
    let code = original
    if (mutation && file === connection) {
      if (code.split(mutation.before).length !== 2) throw Error('Startup mutation must change exactly one original anchor: ' + mutant)
      code = code.replace(mutation.before, mutation.after)
    }
    if (trace) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex'), row = { file, originalSHA256: sha(original), loadedSHA256: sha(code), mutation: mutation && file === connection ? mutant : null }
      appendFileSync(trace, JSON.stringify({ phase: 'transformed', ...row }) + '\n')
      code += `\nimport {appendFileSync as __startupEvaluated} from 'node:fs';__startupEvaluated(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({phase:'evaluated',...row})+'\n')});\n`
    }
    return code === original ? undefined : code
  }
}], test: { ...base.test, include: process.env.MOBILE_STARTUP_RELATED ? ['test/mobile-update-workface.test.tsx', 'test/mobile-update-connection.test.tsx', 'test/short-connection-entry.test.tsx', 'test/connection-admission.test.tsx', 'test/mobile-recovery-connection.test.tsx'] : ['test/mobile-startup.test.tsx'],
  ...(mutation ? { testNamePattern: mutation.target } : {}), maxWorkers: 1, fileParallelism: false, passWithNoTests: false } }
