import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import source from '../../../apps/desktop/test/vitest.hosted-input-preparation.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_INPUT_EVIDENCE_MUTATION
const changes: Record<string, [string, string, string]> = {
  'drop-slow-owner': ['performance-diagnostics.ts', 'if (entry.serviceMs !== null) {', 'if (false) {'],
  'queued-owner': ['client.ts', 'try { const identity = this.runtimeIdentity(); diagnostic.executionOwner(identity.instanceId, identity.hostId)', 'lane.running = diagnostic\n    try { const identity = this.runtimeIdentity(); diagnostic.executionOwner(identity.instanceId, identity.hostId)']
}
if (mutation && !changes[mutation]) throw Error('Unknown input evidence mutation')
export default defineConfig({ resolve: source.resolve, cacheDir: '.cache/input-lane-evidence',
  plugins: [{ name: 'actual-input-evidence-source', enforce: 'pre', transform(original, id) {
    const path = relative(root, id)
    if (!['client.ts', 'prompt-submission.ts', 'performance-diagnostics.ts', 'metrics.ts'].some(name => path === 'packages/core/src/' + name)) return
    const change = mutation && changes[mutation], applies = change && path === 'packages/core/src/' + change[0]
    if (applies && original.split(change[1]).length !== 2) throw Error('Expected one actual source mutation')
    const code = applies ? original.replace(change[1], change[2]) : original
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_INPUT_EVIDENCE_LOADED) appendFileSync(process.env.AGENTMUX_INPUT_EVIDENCE_LOADED,
      JSON.stringify({ path, original: hash(original), loaded: hash(code), mutation: applies ? mutation : null }) + '\n')
    return { code, map: null }
  } }], test: { include: ['packages/core/test/input-lane-evidence.test.ts', 'packages/core/test/performance-stage-diagnostics.test.ts',
    'packages/core/test/performance-hosted-diagnostics.test.ts', 'packages/core/test/client-raw-input-render-preemption.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts')], maxWorkers: 1, fileParallelism: false, passWithNoTests: false, testTimeout: 15000, hookTimeout: 15000 }
})
