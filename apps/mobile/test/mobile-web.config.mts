import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const mutant = process.env.MOBILE_WEB_MUTANT, report = process.env.MOBILE_WEB_LOADED
const variants: Record<string, { file: string; before: string; after: string }> = {
  'read-issue-text': { file: 'apps/mobile/src/mobile-web/reporter.ts', before: "if (!Object.hasOwn(space, 'issue')) continue", after: 'if (!space.issue) continue' },
  'release-real-io': { file: 'apps/mobile/src/mobile-web/reporter.ts', before: 'this.waiting = []; this.client = client; this.connected = false', after: 'this.active = null; this.waiting = []; this.client = client; this.connected = false' },
  'native-controls-reporting': { file: 'apps/mobile/src/mobile-web/reporter.ts', before: "if (event.observationOrigin?.kind === 'runtime-connection' && event.observationOrigin.boundary === 'consumer-core') this.connected", after: 'if (true) this.connected' },
  'different-compiled-build': { file: 'apps/mobile/src/mobile-web/page-identity.ts', before: '? __AGENTMUX_MOBILE_BUILD_ID__ : null', after: "? 'another-served-build' : null" },
  'forget-original-namespace': { file: 'apps/mobile/src/mobile-web/page-identity.ts', before: 'documentId: mintObjectId(), buildId, namespaceDigest', after: 'documentId: mintObjectId(), buildId, namespaceDigest: null' },
  'build-only-current': { file: 'apps/mobile/src/mobile-web/use-mobile-web-observation.ts', before: '&& inspection.active.digest === value.page.namespaceDigest', after: '&& true' },
  'ignore-loaded-occurrence': { file: 'apps/mobile/src/mobile-web/use-mobile-web-observation.ts', before: 'target.loaded.occurrenceId !== loaded.occurrenceId ||', after: 'false ||' },
  'no-foreground-check': { file: 'apps/mobile/src/mobile-web/use-mobile-web-observation.ts', before: '    check()\n    const timer = setInterval', after: '    // Omitted initial check\n    const timer = setInterval' },
  'check-in-background': { file: 'apps/mobile/src/mobile-web/use-mobile-web-observation.ts', before: "if (document.visibilityState !== 'hidden') void refresh()", after: 'if (true) void refresh()' },
  'no-inspection-single-flight': { file: 'apps/mobile/src/mobile-web/use-mobile-web-observation.ts', before: '      if (!requests.inspect) {', after: '      if (true) {' },
  'hide-update-consumer': { file: 'apps/mobile/src/MobileApp.tsx', before: "hidden={mobileWebUpdateStatus(webObservation) !== 'available'}", after: 'hidden={true}' },
  'ignore-host-instance': { file: 'apps/mobile/src/mobile-web/use-mobile-web-observation.ts', before: 'inspection.hostInstanceId !== loaded.hostInstanceId ||', after: 'false ||' },
  'native-as-phone-disconnect': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: "if (event.type !== 'connection-state' || event.observationOrigin?.boundary !== 'consumer-core') return", after: "if (event.type !== 'connection-state') return" },
  'remove-catalog-consumer': { file: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', before: 'if (observed) observeCatalog?.(observed)', after: 'if (false && observed) observeCatalog?.(observed)' }
}
if (mutant && !variants[mutant]) throw new Error('Unknown bounded mobile Web mutation')
const aliases = Object.fromEntries(['core', 'relay', 'identity'].flatMap(name => {
  const manifest = JSON.parse(readFileSync(resolve(root, `packages/${name}/package.json`), 'utf8'))
  return Object.entries(manifest.exports).flatMap(([key, value]: [string, any]) => key.includes('*') ? [] :
    [[`@agentmux/${name}${key === '.' ? '' : key.slice(1)}`, resolve(root, `packages/${name}/src`, value.import.slice(7).replace(/\.js$/u, '.ts'))]])
}))
aliases['@agentmux/identity/runtime-source'] = resolve(root, 'packages/identity/dist/runtime-source.js')
export default defineConfig({ root: resolve(root, 'apps/mobile'), cacheDir: resolve(root, '.tmp/mobile-web-ui', mutant ?? 'normal'),
  define: { __AGENTMUX_MOBILE_BUILD_ID__: JSON.stringify('reviewed-page-build') },
  resolve: { alias: Object.entries(aliases).sort(([left], [right]) => right.length - left.length).map(([find, replacement]) => ({ find, replacement })),
    conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  plugins: [react(), { name: 'loaded-mobile-web-source', enforce: 'pre', transform(original, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!/^apps\/mobile\/src\/(?:mobile-web\/.*\.[jt]sx?|navigation\/MobileSpatialNavigation\.tsx|connection\/MobileConnectionRoot\.tsx|MobileApp\.tsx)$/u.test(file)) return
    let code = original
    const variant = mutant ? variants[mutant] : undefined
    if (variant?.file === file) {
      if (original.split(variant.before).length !== 2) throw new Error('Mutation source anchor must load exactly once: ' + mutant)
      code = original.replace(variant.before, variant.after)
    }
    if (report) {
      const sha = (text: string) => createHash('sha256').update(text).digest('hex')
      const record = { file, originalSHA256: sha(original), loadedSHA256: sha(code), mutation: variant?.file === file ? mutant : null }
      code = `import { appendFileSync as __mobileWebLoaded } from 'node:fs'; __mobileWebLoaded(${JSON.stringify(report)}, ${JSON.stringify(JSON.stringify(record) + '\n')});\n` + code
    }
    return code === original ? undefined : { code, map: null }
  } }],
  test: { include: ['test/mobile-web.test.tsx', 'test/mobile-web-update.test.tsx'], setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts')],
    environment: 'happy-dom', passWithNoTests: false, maxWorkers: 1, fileParallelism: false, restoreMocks: true, testTimeout: 15000 }
})
