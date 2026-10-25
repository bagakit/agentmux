import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const root = resolve(import.meta.dirname, '../../..')
const variants = {
  'raw-ack-serialization': ['client.ts', '            dispatch.releaseAdmission()', '            await completion; dispatch.releaseAdmission()'],
  'raw-completion-retention': ['client.ts', '      lane.pending.delete(completion)', '      /* Incorrectly retain completed input. */'],
  'hosted-write-context': ['hosted-runtime-service.ts', 'rawAgentInput ? [invocation.args[0], rawContext]', "rawAgentInput ? [invocation.args[0], invocation.method === 'writeAgent' ? undefined : rawContext]"],
  'hosted-paste-context': ['hosted-runtime-service.ts', 'rawAgentInput ? [invocation.args[0], rawContext]', "rawAgentInput ? [invocation.args[0], invocation.method === 'pasteAgent' ? undefined : rawContext]"],
  'hosted-terminal-context': ['hosted-runtime-service.ts', 'rawTerminalInput ? [invocation.args[0], invocation.args[1], invocation.args[2], rawContext]', 'rawTerminalInput ? [invocation.args[0], invocation.args[1], invocation.args[2]]'],
  'hosted-context-forgery': ['hosted-runtime-service.ts', '(controlledInput || rawAgentInput) && invocation.args.length !== 1 || rawTerminalInput && (invocation.args.length < 2 || invocation.args.length > 3)', 'controlledInput && invocation.args.length !== 1'],
  'raw-final-authority': ['client.ts', "await diagnostic.measure('input-authority', () => this.assertRawInputCurrent(call))\n        if (!sameRun", '/* Original final authority omitted. */\n        if (!sameRun'],
  'raw-preemption-authority': ['client.ts', 'this.assertRawInputCurrent(call).then(preempt)', 'Promise.resolve().then(preempt)'],
  'raw-author-order': ['client.ts', 'if (preparation) void preparation.catch(() => {})', 'if (preparation) await preparation'],
  'raw-author-observation': ['client.ts', 'await observePromptInput(call.signal, async () => { await call.author!() })', 'await call.author()'],
  'raw-run-observation': ['client.ts', 'observePromptInput(rawInput.signal, () => this.requireCurrentAgentRun(session))', 'this.requireCurrentAgentRun(session)'],
  'typed-run-observation': ['client.ts', 'observePromptInput(preparationSignal, () => this.requireCurrentAgentRun(session))', 'this.requireCurrentAgentRun(session)'],
  'raw-disconnect-tail': ['client.ts', '// Keep the original tail until its actual operation settles.', 'this.agentInputLanes.clear()\n    // Keep the original tail until its actual operation settles.'],
  'raw-disconnect-lifetime': ['client.ts', 'this.connectionEpoch += 1\n    this.cancelInputPreparationObservations()', '/* Original connection lifetime retained incorrectly. */'],
  'raw-final-target': ['client.ts', "if (!sameRun(this.requireAgentSession(session.agentSessionId).run, session.run)) throw new AgentMuxError(\n          'Agent Session changed before native Input dispatch.', 'STALE_AGENT_SESSION')", '/* Original final target check omitted. */'],
  'raw-not-applied-record': ['client.ts', "if (!dispatched || error instanceof AgentMuxError && error.detail === 'not_applied')", "if (error instanceof AgentMuxError && error.detail === 'not_applied')"],
  'raw-original-marker': ['client.ts', 'if (native && native.operationId !== operationId) return current', '/* Wrong native operation may now be cleared. */'],
  'raw-original-request': ['client.ts', 'if (pending?.request.id !== requestId) return current', 'if (!pending) return current'],
  'raw-cancel-after-dispatch': ['client.ts', "await observeNativeInput('accepted')", "call.check()\n      await observeNativeInput('accepted')"]
} as const
const mutation = process.env.AGENTMUX_RAW_INPUT_MUTATION as keyof typeof variants | undefined
if (mutation && !variants[mutation]) throw Error('Unknown raw input authority mutation')
export default defineConfig({ root, cacheDir: resolve(root, '.tmp/raw-input-authority', mutation ?? 'normal'),
  plugins: [{ name: 'raw-input-actual-owner', enforce: 'pre',
    resolveId(source, importer) {
      if (source === '@agentmux/core') return resolve(root, 'packages/core/src/index.ts')
      if (source === '@agentmux/connectors') return resolve(root, 'packages/connectors/src/index.ts')
      if (source.startsWith('@agentmux/core/')) {
        const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + source.slice('@agentmux/core/'.length)]?.import
        if (typeof entry === 'string' && entry.startsWith('./dist/')) return resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
      }
      if (!importer || !source.startsWith('.')) return
      const dist = resolve(dirname(importer), source).match(/\/packages\/(core|connectors)\/dist\/(.+)\.js$/u)
      if (dist) return resolve(root, 'packages', dist[1]!, 'src', dist[2]! + '.ts')
    },
    transform(original, id) {
      const path = relative(root, id.split('?')[0]!)
      if (!/^(packages\/core|apps\/(host|mobile))\/src\/.+\.ts$/u.test(path)) return
      const selected = mutation && variants[mutation]
      let code = original
      if (selected && path === 'packages/core/src/' + selected[0]) {
        if (original.split(selected[1]).length !== 2) throw Error('Raw input mutation must match exactly one owning expression')
        code = original.replace(selected[1], selected[2])
      }
      const report = process.env.AGENTMUX_RAW_INPUT_LOADED
      if (!report) return code === original ? undefined : { code, map: null }
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      const row = { path, originalSHA256: sha(original), servedSHA256: sha(code), ...(code === original ? {} : { mutation }) }
      return { code: "import { appendFileSync as __rawOwnerLoaded } from 'node:fs'; __rawOwnerLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code, map: null }
    }
  }], test: { include: ['packages/core/test/raw-input-authority.test.ts', 'packages/core/test/input-authority-cancellation.test.ts',
    'packages/core/test/client-raw-input-cross-client.test.ts', 'packages/core/test/client-raw-input-render-preemption.test.ts',
    'packages/core/test/ctxmux-input-channel-lifetime.test.ts'],
    setupFiles: [resolve(root, 'vitest.setup.ts'), resolve(root, 'packages/core/test/helpers/raw-input-private-state.ts')], environment: 'node', passWithNoTests: false,
    fileParallelism: false, maxWorkers: 1, testTimeout: 10_000, hookTimeout: 15_000,
    ...(process.env.AGENTMUX_RAW_INPUT_PATTERN ? { testNamePattern: process.env.AGENTMUX_RAW_INPUT_PATTERN } : {}) }
})
