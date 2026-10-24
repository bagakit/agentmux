import { defineConfig } from 'vitest/config'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'global-reader-failure': ['ctxmux-run-adapter.ts', 'if (this.client === sourceClient && this.attachments.get(runId) === current &&', 'this.markConnectionLost(); if (this.client === sourceClient && this.attachments.get(runId) === current &&'],
  'silent-reader-end': ['ctxmux-run-adapter.ts', "this.eventListener?.({ type: 'attachment-state', state: 'unavailable', runId,\n          afterByte: current.publishedThroughByte, error: current.unavailable })", 'void 0'],
  'lost-cursor': ['ctxmux-run-adapter.ts', 'current.attachment = null', 'current.attachment = null; current.publishedThroughByte = 0'],
  'lost-utf8': ['ctxmux-run-adapter.ts', 'decoder.decode(seed, { stream: true })', '/* Original UTF-8 carry discarded. */'],
  'late-owner': ['ctxmux-run-adapter.ts', 'if (this.attachments.get(runId)?.token !== token) return', '/* Superseded reader still publishes. */'],
  'opening-owner': ['ctxmux-run-adapter.ts', 'this.attachmentOpenings.get(runId) !== opening', 'false'],
  'publication-pump': ['ctxmux-run-adapter.ts', 'void this.pump(runId, token, attachment, decoder)', 'if (replace) void this.pump(runId, token, attachment, decoder)'],
  'identity-generation': ['ctxmux-run-adapter.ts', 'this.client === client && error instanceof CtxmuxRuntimeIdentityMismatchError', 'error instanceof CtxmuxRuntimeIdentityMismatchError'],
  'identity-recovery': ['ctxmux-run-adapter.ts', 'this.client === client && error instanceof CtxmuxRuntimeIdentityMismatchError', 'false'],
  'terminal-fact': ['ctxmux-stream-end.ts', "return observation.sawTerminalEvent ? 'run-exited' : 'observation-unavailable'", "return 'observation-unavailable'"],
  'endpoint-lineage': ['ctxmux-run-adapter.ts', 'if (previous?.runtimeId !== runtime.runtimeId)', 'if (false)'],
  'endpoint-pending': ['client.ts', "if (epoch !== this.connectionEpoch) return\n    this.reconnectEndpoint = { ...observation", "if (epoch !== this.connectionEpoch || this.reconnectController) return\n    this.reconnectEndpoint = { ...observation"],
  'explicit-activation': ['client.ts', 'await this.kernel.connect({ refreshEndpointForRun: endpoint.runId })', 'await this.kernel.reobserveConnection(endpoint.runId)'],
  'explicit-refresh': ['ctxmux-run-adapter.ts', 'if (this.client !== null && !options?.refreshEndpointForRun) return', 'if (this.client !== null) return'],
  'explicit-lineage': ['ctxmux-run-adapter.ts', 'if (previousRuntime && previousRuntime.runtimeId !== runtime.runtimeId)', 'if (false)'],
  'explicit-generation': ['ctxmux-run-adapter.ts', 'if (this.client !== previousClient || this.runtime !== previousRuntime)', 'if (false)'],
  'explicit-unbounded': ['ctxmux-run-adapter.ts', 'this.readRuntimeEndpoint(options.refreshEndpointForRun, previousRuntime)', 'diagnosticsClient.runtimeInfo()'],
  'native-initial-pin': ['hosted-client.ts', 'acceptOwner(observedOwner)', '/* Native owner receipt ignored. */'],
  'native-late-pin': ['hosted-client.ts', 'observedOwner && controlOwner?.ctxmux?.instanceId === nativeAtAdmission', 'observedOwner'],
  'initial-owner-cut': ['hosted-runtime-service.ts', 'initial: { owner: observedOwner, transferId: output.initialId }', 'initial: { owner, transferId: output.initialId }'],
  'reader-routing': ['hosted-runtime-service.ts', "const terminal = event.type === 'terminal-output' || event.type === 'terminal-snapshot' || event.type === 'terminal-resized' || event.type === 'attachment-state'", "const terminal = event.type === 'terminal-output' || event.type === 'terminal-snapshot' || event.type === 'terminal-resized'"]
} as const
const report = process.env.AGENTMUX_ATTACHMENT_LOADED
const mutation = process.env.AGENTMUX_ATTACHMENT_MUTATION as keyof typeof variants | undefined
const patterns: Record<keyof typeof variants, string> = {
  'global-reader-failure': 'keeps both original inputs', 'silent-reader-end': 'keeps both original inputs',
  'lost-cursor': 'keeps both original inputs', 'lost-utf8': 'preserves exact raw cursor',
  'late-owner': 'ignores stale output', 'opening-owner': 'discards an opening.*replace',
  'publication-pump': 'keeps a pumped owner', 'identity-generation': 'does not let a stale opening identity',
  'identity-recovery': 'requests endpoint reconfirmation', 'terminal-fact': 'keeps normal exit',
  'endpoint-lineage': 'pins re-observation', 'endpoint-pending': 'joins an already-owned global',
  'explicit-activation': 'lets an explicit original connect', 'explicit-refresh': 'confirms an explicit endpoint in place',
  'explicit-lineage': 'rejects a foreign explicit endpoint', 'explicit-generation': 'ignores an explicit endpoint confirmation',
  'explicit-unbounded': 'ends a stalled explicit endpoint observation',
  'native-initial-pin': 'takes the exact successful Attachment cut owner', 'native-late-pin': 'never moves the current Native',
  'initial-owner-cut': 'takes the exact successful Attachment cut owner', 'reader-routing': 'delivers native reader faults'
}
if (mutation && !variants[mutation]) throw new Error('Unknown Attachment isolation mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.local/cache/run-attachment-isolation', mutation ?? 'normal'),
  plugins: [{ name: 'actual-attachment-owner', enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
      if (source.startsWith('@agentmux/core/')) {
        const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
        if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
      }
      if (!importer || !source.startsWith('.')) return
      const dist = resolve(dirname(importer), source).match(/\/packages\/core\/dist\/(.+)\.js$/u)
      if (dist) return resolve(root, 'packages/core/src', dist[1]! + '.ts')
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!/^packages\/core\/src\/.+\.ts$/u.test(path)) return
      const selected = mutation && variants[mutation]
      let code = original
      if (selected && path === 'packages/core/src/' + selected[0]) {
        const matches = original.split(selected[1]).length - 1
        const expected = mutation === 'opening-owner' ? 3 : mutation === 'publication-pump' ? 2 : 1
        if (matches !== expected) throw new Error('Attachment mutation must match the exact owning expressions')
        code = original.replaceAll(selected[1], selected[2])
      }
      if (!report) return code === original ? undefined : { code, map: null }
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: sha(original), servedSHA256: sha(code), ...(code === original ? {} : { mutation }) }
      return { code: "import { appendFileSync as __attachmentLoaded } from 'node:fs'; __attachmentLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code, map: null }
    }
  }], test: { include: ['packages/core/test/run-attachment-isolation.test.ts', 'packages/core/test/ctxmux-stream-end.test.ts',
    'packages/core/test/ctxmux-run-adapter-decoder-seam.test.ts', 'packages/core/test/client-terminal-reconnect-continuation.test.ts',
    'packages/core/test/client-terminal-attachment-refresh.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts'), resolve(root, 'packages/core/test/helpers/hosted-stop-private-state.ts')], environment: 'node',
    passWithNoTests: false, fileParallelism: false, maxWorkers: 1, testTimeout: 10_000, hookTimeout: 15_000,
    ...(mutation ? { testNamePattern: patterns[mutation] } : {}) }
})
