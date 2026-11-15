import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import react from '@vitejs/plugin-react'
import base from '../../../packages/core/test/mobile-terminal-coalescing.config.mts'
import owning from '../../desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'

const root = resolve(import.meta.dirname, '../../..'), trace = process.env.MOBILE_EXACT_LOADED
const graph = process.env.MOBILE_EXACT_GRAPH
const mutant = process.env.MOBILE_EXACT_MUTANT
const variants: Record<string, { file: string; before: string; after: string; test: string }> = {
  'wait-whole-directory': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: "sessions: 'summary', waitForReady: false", after: "sessions: 'summary', waitForReady: true", test: '^actual main reads' },
  'directory-closes-conversation': { file: 'apps/mobile/src/connection/MobileConnectionRoot.tsx', before: '        release = value.onEvent(event => {',
    after: "        release = value.onEvent(event => {\n          if (event.type === 'session-observation-state' && event.observation.state === 'unavailable') { observation = { state: 'disconnected', message: 'Directory failed' }; publish(); return }", test: '^actual main reads' },
  'focus-misses-empty-ready': { file: 'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', before: "if (event.type === 'session-observation-state') {", after: "if (event.type === 'session-observation-state') return\n      if (false) {", test: '^the original Focus' },
  'references-miss-empty-ready': { file: 'apps/mobile/src/conversation/use-mobile-agent-references.ts', before: "event.type === 'session-observation-state' || event.type === 'connection-state'", after: "event.type === 'connection-state'", test: '^the original Focus' },
}
if (mutant && !variants[mutant]) throw Error('Unknown Mobile exact-first-read mutation')
if (mutant && !trace) throw Error('A mutation requires an evaluated-source trace')
const variant = mutant ? variants[mutant] : undefined
const { buildSync } = createRequire(resolve(root, 'packages/core/package.json'))('esbuild')
const listener = resolve(root, '.tmp/mobile-exact-first-read/listener.mjs')
buildSync({ entryPoints: [resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: listener,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
process.env.HOST_LIFECYCLE_LISTENER_ENTRY = listener
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--import', JSON.stringify(resolve(root, 'apps/host/test/host-lifecycle-recovery-node-loader.mjs'))].filter(Boolean).join(' ')
const aliases = (owning.resolve!.alias as Array<{ find: RegExp; replacement: string }>).filter(item =>
  !item.find.test('@agentmux/identity/runtime-source'))
const owners = new Set(['apps/mobile/src/main.tsx', 'apps/mobile/src/connection/MobileConnectionRoot.tsx', 'apps/mobile/src/MobileApp.tsx',
  'apps/mobile/src/conversation/use-hosted-conversation.ts', 'apps/mobile/src/conversation/MobileConversationSurface.tsx',
  'apps/mobile/src/navigation/MobileSpatialNavigation.tsx', 'apps/mobile/src/conversation/use-mobile-agent-references.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/relay-hosted.ts', 'apps/mobile/test/mobile-exact-first-read.test.tsx'])
export default { ...base, root: resolve(root, 'apps/mobile'), resolve: { ...base.resolve, alias: [...aliases,
  ...base.resolve!.alias as Array<{ find: RegExp; replacement: string }>],
  conditions: ['browser', 'module', 'import'], dedupe: ['react', 'react-dom'] },
  cacheDir: resolve(root, '.tmp/mobile-exact-first-read/cache'),
  plugins: [react(), ...base.plugins ?? [], { name: 'evaluated-mobile-exact-first-read', enforce: 'pre' as const, transform(code: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (graph && /^(?:apps\/(?:mobile|host)|packages\/[^/]+)\/.+\.[cm]?[jt]sx?$/u.test(file) && !file.includes('/node_modules/')) {
      appendFileSync(graph, JSON.stringify({ file, sha256: createHash('sha256').update(code).digest('hex') }) + '\n')
    }
    if (!trace || !owners.has(file)) return
    let loaded = code
    if (variant?.file === file) {
      if (code.split(variant.before).length !== 2) throw Error('Mutation must change one original anchor: ' + mutant)
      loaded = code.replace(variant.before, variant.after)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { file, originalSHA256: hash(code), loadedSHA256: hash(loaded), mutation: variant?.file === file ? mutant : null }
    appendFileSync(trace, JSON.stringify({ phase: 'transformed', ...row }) + '\n')
    return loaded + `\nimport {appendFileSync as __mobileExactEvaluated} from 'node:fs';__mobileExactEvaluated(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({phase:'evaluated',...row})+'\n')});\n`
  } }], test: { ...base.test, include: ['test/mobile-exact-first-read.test.tsx'], environment: 'node', environmentMatchGlobs: [],
    setupFiles: [resolve(root, 'apps/mobile/test/device-locks.ts')], ...(variant ? { testNamePattern: variant.test } : {}),
    maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 30000, hookTimeout: 20000 } }
