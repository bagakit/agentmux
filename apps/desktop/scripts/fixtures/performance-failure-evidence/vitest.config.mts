import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { strict as assert } from 'node:assert'
const root = resolve(import.meta.dirname, '../../../../..')
const mutant = process.env.AGENTMUX_PERFORMANCE_FAILURE_MUTANT ?? 'baseline'
const changes: Record<string, [string, string, string]> = {
  'capture-opt-in': ['apps/desktop/src/main/toolkit-owner.ts', 'execution.captureFailure = captureFailure', 'execution.captureFailure = true'],
  'origin-stage': ['apps/desktop/src/main/toolkit-owner.ts', "execution.stage = 'toolkit-json'", "execution.stage = 'toolkit-envelope'"],
  'original-run': ['apps/desktop/src/main/toolkit-owner.ts', "run: execution.ref ? { hostId: 'local', runId: execution.ref.runId } : null, recordedAt:", "run: null, recordedAt:"],
  'durable-ack': ['apps/desktop/src/main/toolkit-owner.ts', "this.value.diagnostics.persistence = 'confirmed'", "this.value.diagnostics.persistence = 'pending'"],
  'failure-byte-budget': ['packages/core/src/toolkit-performance-failure.ts', 'TOOLKIT_PERFORMANCE_FAILURE_MAX_BYTES = 128 * 1024', 'TOOLKIT_PERFORMANCE_FAILURE_MAX_BYTES = 96 * 1024'],
  'clip-range': ['packages/core/src/toolkit-performance-failure.ts', 'omittedBytes: this.length - this.prefix.length - this.suffix.length', 'omittedBytes: 0'],
  'codec-range': ['packages/core/src/toolkit-performance-failure.ts', 'total !== lengths[0]! + lengths[1]! + (bytes.omittedBytes as number)', 'false'],
  'public-option': ['packages/core/src/public-rpc-service.ts', '...(request.captureFailure ? { captureFailure: true as const } : {})', '...{}'],
  'issue-safe-read': ['apps/desktop/src/main/toolkit-owner.ts', '{ ...issue, message: null }', '{ ...issue, message: issue.message }'],
  'safe-read': ['apps/desktop/src/main/toolkit-owner.ts', 'bytes: null, ...(failure.details.diagnosticOutput ? { diagnosticOutput: [] } : {}), error: { ...failure.details.error, message: null, stack: null }', 'bytes: failure.details.bytes, error: { ...failure.details.error, message: failure.details.error.message, stack: failure.details.error.stack }'],
  'stack-opt-in': ['packages/core/src/toolkit-performance-failure.ts', 'includeStack = false', 'includeStack = true'],
  'bounded-pending': ['apps/desktop/src/main/toolkit-performance-failure-store.ts', "replaced?.reject(new AgentMuxError('A newer Performance capture replaced this pending diagnostic write; its original failure remains independent.', 'TOOLKIT_DIAGNOSTIC_SUPERSEDED'))", 'void replaced'],
  'event-stage': ['apps/desktop/src/main/toolkit-owner.ts', "execution.stage = 'run-event'", "execution.stage = 'attach'"],
  'original-code': ['packages/core/src/toolkit-performance-failure.ts', "code: typeof code === 'string' ? clip(code, 128) : null", 'code: null'],
  'write-phase': ['apps/desktop/src/main/toolkit-owner.ts', 'phase: error instanceof DurableWriteError ? error.phase : null', 'phase: null'],
  'reader-dispose': ['apps/desktop/src/main/toolkit-owner.ts', 'this.leases.delete(lease)', '/* mutated reader release */'],
}
assert.ok(mutant === 'baseline' || changes[mutant], 'Unknown mutant')
let loaded = false
const evidence = process.env.AGENTMUX_PERFORMANCE_FAILURE_EVIDENCE
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/performance-failure', mutant),
  resolve: { alias: [
    { find: /^@agentmux\/demand$/, replacement: resolve(root, 'packages/demand/src/index.ts') },
    { find: /^@agentmux\/demand\/(.+)$/, replacement: resolve(root, 'packages/demand/src/$1.ts') },
    { find: /^@agentmux\/core\/object-id$/, replacement: resolve(root, 'packages/core/src/object-id.ts') },
    { find: /^@agentmux\/core\/toolkit$/, replacement: resolve(root, 'packages/core/src/toolkit.ts') },
    { find: /^@agentmux\/core\/toolkit-result-document$/, replacement: resolve(root, 'packages/core/src/toolkit-result-document.ts') },
    { find: /^@agentmux\/core\/toolkit-performance-failure$/, replacement: resolve(root, 'packages/core/src/toolkit-performance-failure.ts') },
    { find: /^@agentmux\/core\/toolkit-result-channel$/, replacement: resolve(root, 'packages/core/src/toolkit-result-channel.ts') },
    { find: /^@agentmux\/core\/control$/, replacement: resolve(root, 'packages/core/src/control.ts') },
    { find: /^@agentmux\/core\/public-rpc-http$/, replacement: resolve(root, 'packages/core/src/public-rpc-http.ts') },
    { find: /^@agentmux\/core$/, replacement: resolve(root, 'packages/core/src/index.ts') }
  ] },
  plugins: [{ name: 'actual-performance-failure-source', enforce: 'pre', transform(input, id) {
    const path = relative(root, id.split('?')[0]!), change = changes[mutant]
    if (!['packages/core/src/toolkit-performance-failure.ts', 'packages/core/src/public-rpc-service.ts', 'apps/desktop/src/main/toolkit-owner.ts', 'apps/desktop/src/main/toolkit-performance-failure-store.ts', 'packages/core/src/toolkit-cli.ts'].includes(path)) return
    let code = input
    if (change?.[0] === path) {
      assert.equal(input, readFileSync(id.split('?')[0]!, 'utf8'), 'Actual production source')
      assert.equal(input.split(change[1]).length, 2, 'Exactly one actual mutation hunk')
      code = input.replace(change[1], change[2]); loaded = true
    }
    const sha = (text: string) => createHash('sha256').update(text).digest('hex')
    if (evidence) appendFileSync(resolve(evidence, 'loaded-source.jsonl'), JSON.stringify({ path, mutant, sourceSHA256: sha(input), consumedSHA256: sha(code) }) + '\n')
    return code === input ? undefined : { code, map: null }
  }, closeBundle() { if (mutant !== 'baseline') assert.ok(loaded, 'Nonempty consumed mutation') } }],
  test: { include: ['packages/core/test/toolkit-performance-failure.test.ts', 'apps/desktop/test/toolkit-performance-failure.test.ts',
      ...(process.env.AGENTMUX_PERFORMANCE_FAILURE_FORMAL_CLI ? ['apps/desktop/test/toolkit-performance-failure-cli.test.ts'] : [])],
    passWithNoTests: false, maxWorkers: 1, testTimeout: 10000, hookTimeout: 10000 }
})
