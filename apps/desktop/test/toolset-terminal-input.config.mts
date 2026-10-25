import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import rawInput from '../../../packages/core/test/raw-input-authority.config.mts'

const root = resolve(import.meta.dirname, '../../..'), mutation = process.env.TOOLSET_INPUT_MUTATION
const changes: Record<string, [string, string, string]> = {
  'protocol-bypass': ['apps/desktop/src/main/runtime-controller.ts', "await this.write({ kind: 'agent', hostId, agentSessionId, run: { runId } }, data, 'terminal-protocol')", "await (await this.connectedClient(hostId, 'runtime')).writeAgent({ agentSessionId, expectedRun: { runId }, data, source: 'terminal-protocol' })"],
  'ack-order': ['packages/core/src/client.ts', "      releaseAdmission()\n      return await diagnostic.measure('native-input', () => completion)", "      const result = await diagnostic.measure('native-input', () => completion)\n      releaseAdmission()\n      return result"],
  'main-preflight': ['apps/desktop/src/main/runtime-controller.ts', "if (scope === 'raw-input' && 'runtimeOwnerIdentity' in client) return client", "if (false && scope === 'raw-input' && 'runtimeOwnerIdentity' in client) return client"],
  'terminal-context': ['packages/core/src/hosted-runtime-service.ts', ': rawTerminalInput ? [invocation.args[0], invocation.args[1], invocation.args[2], rawContext]', ': rawTerminalInput ? [invocation.args[0], invocation.args[1], invocation.args[2]]']
}
if (mutation && mutation !== 'split-capacity' && !changes[mutation]) throw Error('Unknown toolset input mutation')
export default defineConfig({ ...rawInput, cacheDir: resolve(root, '.cache/toolset-terminal-input', mutation ?? 'baseline'),
  plugins: [...(rawInput.plugins ?? []), { name: 'toolset-input-actual-source', enforce: 'pre',
    async resolveId(source) {
      if (source === '@ctxmux/sdk') return await this.resolve(source, resolve(root, 'packages/core/src/ctxmux-run-adapter.ts'), { skipSelf: true })
    },
    transform(original, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!/^(packages\/core|apps\/desktop)\/src\/.+\.ts$/u.test(path)) return
    let code = original
    const change = mutation && changes[mutation]
    if (change && path === change[0]) {
      if (code.split(change[1]).length !== 2) throw Error('Toolset source mutation must match exactly once')
      code = code.replace(change[1], change[2])
    }
    if (mutation === 'split-capacity' && path === 'packages/core/src/client.ts') {
      const pattern = /this\.rawInputAdmissions\.(get|set|delete)\(runId/gu
      if ([...code.matchAll(pattern)].length !== 4) throw Error('Exact physical admission mutation changed')
      code = code.replace(pattern, "this.rawInputAdmissions.$1(channel ? runId + ':split-agent' : runId")
    }
    const report = process.env.TOOLSET_INPUT_LOADED
    if (report) {
      const sha = (s: string) => createHash('sha256').update(s).digest('hex')
      const row = { path, originalSHA256: sha(original), servedSHA256: sha(code), ...(original === code ? {} : { mutation }) }
      return { code: "import { appendFileSync as __toolsetLoaded } from 'node:fs'; __toolsetLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n' + code, map: null }
    }
    if (code !== original) return { code, map: null }
  } }],
  test: { ...rawInput.test, include: ['apps/desktop/test/toolset-terminal-input-native.test.ts', 'packages/core/test/terminal-byte-authority.test.ts', 'apps/desktop/test/main-terminal-input-diagnostics.test.ts'],
    testTimeout: 15_000, hookTimeout: 15_000, passWithNoTests: false }
})
