import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import base from './session-continuity-core.config.mts'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(resolve(root, 'apps/desktop/package.json'))
const helper = 'apps/desktop/src/renderer/src/lib/terminal-initial-observation-recovery.ts'
const terminal = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const variants = {
  'first-visible-read': { file: helper, from: 'this.independentRead = visible', to: 'this.independentRead = false', count: 2,
    pattern: 'visible observation restores the original agent on first visible mount' },
  'finite-window': { file: helper, from: 'this.independentRead = false\n      this.attempts++', to: 'this.independentRead = true\n      this.attempts++', count: 1,
    pattern: 'visible observation gives persistent bad transfer one independent read per visible window' },
  'subject-validation': { file: terminal, from: '!sameSession || result.session.hostId !== session.hostId ||\n          result.session.control.hostId !== session.control.hostId || result.session.control.run.runId !== session.control.run.runId', to: 'false', count: 1,
    pattern: 'retains the first returned lease but refuses a foreign Run continuation' }
} as const
const name = process.env.AGENTMUX_TERMINAL_SWITCH_MUTATION as keyof typeof variants | undefined
assert.ok(!name || Object.hasOwn(variants, name), 'Known terminal switch mutation')
const chosen = name ? variants[name] : undefined
const tracked = new Set([helper, terminal, 'apps/desktop/src/renderer/src/lib/terminal-attachment-observation.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/renderer/src/lib/api.ts', 'packages/core/src/hosted-client.ts', 'packages/core/src/public-rpc-client.ts',
  'packages/core/src/hosted-value.ts'])
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, root,
  cacheDir: resolve(root, '.local/cache/terminal-switch-observation', name ?? 'baseline'),
  esbuild: { jsx: 'automatic' as const },
  resolve: { ...base.resolve, conditions: ['browser', 'module', 'development|production'], alias: [
    ...['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'].map(id => ({ find: new RegExp('^' + id + '$'), replacement: require.resolve(id) })),
    ...base.resolve!.alias
  ] },
  plugins: [{ name: 'terminal-switch-loaded-source', enforce: 'pre' as const,
    transform(source: string, id: string) {
      const file = relative(root, id.split('?')[0]!)
      if (!tracked.has(file)) return
      let loaded = source
      if (file === chosen?.file) {
        assert.equal(source.split(chosen.from).length - 1, chosen.count, 'Exact owning mutation anchor count')
        loaded = source.replaceAll(chosen.from, chosen.to)
      }
      if (process.env.AGENTMUX_TERMINAL_SWITCH_LOADED) appendFileSync(resolve(process.env.AGENTMUX_TERMINAL_SWITCH_LOADED), JSON.stringify({ file,
        sourceSHA256: digest(source), loadedSHA256: digest(loaded), mutation: loaded === source ? null : name }) + '\n')
      return loaded === source ? undefined : { code: loaded, map: null }
    }
  }],
  test: { ...base.test, globalSetup: [],
    include: ['apps/desktop/test/terminal-initial-observation-recovery.test.tsx', 'apps/desktop/test/terminal-observation-error.test.ts'],
    testNamePattern: chosen?.pattern ?? 'visible observation|automatically restores the original private|holds the actual first request|bounds one failure window|cancels a hidden|retains the first returned lease|Toolkit Check status reconnects|admits the original connection codes|keeps unknown error-code',
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, hookTimeout: 40_000, testTimeout: 30_000
  }
}
