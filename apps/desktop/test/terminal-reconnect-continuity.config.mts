import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import base from './session-continuity-core.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const require = createRequire(resolve(root, 'apps/desktop/package.json'))
const owner = 'apps/desktop/src/renderer/src/lib/session-events.ts'
const terminal = 'apps/desktop/src/renderer/src/components/TerminalView.tsx'
const variants = {
  'missing-connection': { file: owner, from: "core.type === 'connection-state'", to: "false && core.type === 'connection-state'" },
  'foreign-host': { file: owner, from: 'hosts.get(event.hostId)?.values() ?? []', to: '[...hosts.values()].flatMap(runs => [...runs.values()])' },
  'replace-reading': { file: terminal, from: 'const continued = await applyContinuation(snapshot, true)', to: 'const continued = await applyContinuation(snapshot)' },
  'false-recovery': { file: terminal, from: 'if (!continued) continue', to: 'if (!continued) setContinuationAbsence(null)' },
  'clear-history-gap': { file: terminal, from: '// A continuous suffix confirms this canvas', to: 'setRuntimeHistoryGap(false)\n              setReplayGap(false)\n              // A continuous suffix confirms this canvas' }
} as const
const mutation = process.env.AGENTMUX_TERMINAL_RECONNECT_MUTATION as keyof typeof variants | undefined
const target = process.env.AGENTMUX_TERMINAL_RECONNECT_TARGET
const scope = process.env.AGENTMUX_TERMINAL_RECONNECT_SCOPE
assert.ok(scope === 'events' || scope === 'reading', 'Exact implemented proof scope')
assert.ok(target === 'api' || target === 'native' || target === 'reading' || target === 'checkpoint', 'Exact product consumer target')
assert.ok(!mutation || Object.hasOwn(variants, mutation), 'Known original-source mutation')
const chosen = mutation ? variants[mutation] : undefined
const tracked = new Set([owner,
  'apps/desktop/src/renderer/src/lib/api.ts', 'apps/desktop/src/renderer/src/components/TerminalView.tsx',
  'apps/desktop/src/renderer/src/lib/terminal-initial-observation-recovery.ts',
  'apps/desktop/src/main/runtime-controller.ts', 'apps/desktop/src/main/ipc.ts', 'apps/desktop/src/preload/index.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/public-rpc-client.ts', 'packages/core/src/hosted-value.ts'])
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export default { ...base, root,
  cacheDir: resolve(process.env.AGENTMUX_TERMINAL_RECONNECT_CACHE!),
  esbuild: { jsx: 'automatic' as const },
  resolve: { ...base.resolve, conditions: ['browser', 'module', 'development|production'], alias: [
    ...['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'].map(id => ({
      find: new RegExp('^' + id + '$'), replacement: require.resolve(id) })),
    ...base.resolve!.alias
  ] },
  plugins: [{ name: 'terminal-reconnect-original-source', enforce: 'pre' as const,
    transform(source: string, id: string) {
      const file = relative(root, id.split('?')[0]!)
      if (!tracked.has(file)) return
      let loaded = source
      if (file === chosen?.file) {
        assert.equal(source.split(chosen.from).length - 1, 1, 'Exactly one production mutation anchor')
        loaded = source.replace(chosen.from, chosen.to)
      }
      if (process.env.AGENTMUX_TERMINAL_RECONNECT_LOADED) appendFileSync(process.env.AGENTMUX_TERMINAL_RECONNECT_LOADED,
        JSON.stringify({ file, sourceSHA256: digest(source), loadedSHA256: digest(loaded),
          mutation: loaded === source ? null : mutation }) + '\n')
      return loaded === source ? undefined : { code: loaded, map: null }
    }
  }],
  test: { ...base.test, globalSetup: [],
    include: [target === 'api' ? 'apps/desktop/test/renderer-session-events.test.ts'
      : target === 'reading' ? 'apps/desktop/test/terminal-reconnect-reading.test.tsx'
        : target === 'checkpoint' ? 'apps/desktop/test/terminal-checkpoint-continuation.test.tsx'
          : 'apps/desktop/test/terminal-initial-observation-recovery.test.tsx'],
    testNamePattern: process.env.AGENTMUX_TERMINAL_RECONNECT_PATTERN || undefined,
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, hookTimeout: 40_000, testTimeout: 30_000
  }
}
