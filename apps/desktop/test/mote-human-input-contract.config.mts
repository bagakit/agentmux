import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import base from './vitest.mote-context.config.mts'

const root = resolve(import.meta.dirname, '../../..')
// Publication forks its package asset. Build just that private leaf, leaving shared dist untouched.
const { buildSync } = createRequire(resolve(root, 'packages/core/package.json'))('esbuild')
const listener = resolve(root, '.tmp/mote-human-input-contract/listener.mjs')
buildSync({ entryPoints: [resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: listener,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
process.env.HOST_LIFECYCLE_LISTENER_ENTRY = listener
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--import', JSON.stringify(resolve(root, 'apps/host/test/host-lifecycle-recovery-node-loader.mjs'))].filter(Boolean).join(' ')
const owners = new Set([
  'apps/desktop/src/renderer/src/store.ts',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
  'apps/desktop/src/renderer/src/components/MoteWorkface.tsx',
  'apps/desktop/src/main/runtime-controller.ts',
  'apps/host/src/mote-dialogue.ts',
  'packages/core/src/public-rpc-service.ts',
  'packages/core/src/prompt-submission.ts',
  'packages/core/src/ctxmux-run-adapter.ts'
])
const selected = process.env.AGENTMUX_MOTE_HUMAN_MUTATION
if (selected && selected !== 'restore-native-only-main') throw Error('Unknown Mote human input mutant: ' + selected)
const sha = (source: string | Buffer) => createHash('sha256').update(source).digest('hex')
export default { ...base, cacheDir: resolve(root, '.cache/mote-human-input-contract'),
  plugins: [...base.plugins ?? [], { name: 'mote-human-input-owner', enforce: 'pre' as const, transform(source: string, id: string) {
    const file = relative(root, id.split('?')[0]!)
    if (id.includes('?') || !owners.has(file)) return
    const applies = selected && file === 'apps/desktop/src/renderer/src/store.ts'
    const from = "{ expectedRun: { ...session.control.run }, ...(session.inputEpoch === undefined ? {} : { inputEpoch: session.inputEpoch }), admissionIntent: { kind: 'manual-actor' } }"
    if (applies && source.split(from).length !== 2) throw Error('Mote human input mutation must match one evaluated producer')
    const code = applies ? source.replace(from,
      from.replace("kind: 'manual-actor'", "kind: options?.moteMain ? 'session-conversation' : 'manual-actor'")) : source
    const trace = process.env.AGENTMUX_MOTE_HUMAN_TRACE
    if (!trace) return applies ? { code, map: null } : undefined
    const fact = { file, fileSHA256: sha(readFileSync(id)), sourceSHA256: sha(source), loadedSHA256: sha(code), mutation: applies ? selected : null }
    appendFileSync(trace, JSON.stringify({ ...fact, stage: 'loaded' }) + '\n')
    return { code: code + '\nimport { appendFileSync as __humanInputTrace } from "node:fs";\n' +
      '__humanInputTrace(' + JSON.stringify(trace) + ', ' + JSON.stringify(JSON.stringify({ ...fact, stage: 'evaluated' }) + '\n') + ');\n', map: null }
  } }],
  test: { ...base.test, name: 'mote-human-input-contract', include: process.env.AGENTMUX_TEST_MOTE_HUMAN_ADJACENT ? [
      'apps/desktop/test/mote-composer-continuity.test.tsx', 'apps/desktop/test/browser-contextual-queue.test.ts',
      'apps/desktop/test/composer-send-while-request-pending.test.ts', 'apps/desktop/test/session-startup-service-window.test.tsx',
      'apps/desktop/test/session-continuity-launch-consumer.test.ts'
    ] : ['apps/desktop/test/mote-human-input-contract.test.tsx'],
    maxWorkers: 1, fileParallelism: false, testTimeout: 30_000, passWithNoTests: false }
}
