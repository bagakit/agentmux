import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { createRequire } from 'node:module'
import preparation from './vitest.hosted-input-preparation.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const { buildSync } = createRequire(resolve(root, 'packages/core/package.json'))('esbuild')
const listener = resolve(root, '.tmp/desktop-directory-consumers/listener.mjs')
buildSync({ entryPoints: [resolve(root, 'packages/core/src/control-endpoint-listener-worker.ts')], outfile: listener,
  bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent' })
process.env.HOST_LIFECYCLE_LISTENER_ENTRY = listener
process.env.NODE_OPTIONS = [process.env.NODE_OPTIONS, '--import', JSON.stringify(resolve(root, 'apps/host/test/host-lifecycle-recovery-node-loader.mjs'))].filter(Boolean).join(' ')
const trace = process.env.DESKTOP_DIRECTORY_LOADED
const controller = 'apps/desktop/src/main/runtime-controller.ts'
export const variants = {
  'ignore-directory-ready': { file: 'apps/desktop/src/main/desktop-host.ts', pattern: 'wakes the original launch waiter',
    changes: [["if (event.type === 'session-observation-state' && event.observation.state === 'ready') { confirm(); return }", '']] },
  'directory-as-control': { file: controller, pattern: 'keeps a directory failure in its own service window',
    changes: [["if ('sessionObservation' in client) return", "if (false && 'sessionObservation' in client) return"]] },
  'hint-requires-directory': { file: controller, pattern: 'control is confirmed$',
    changes: [["if ('sessionObservation' in host.client && !host.client.sessionObservation().hasSnapshot) return false", '']] },
  'draft-requires-directory': { file: controller, pattern: 'corrects an unadopted SSH connection draft',
    changes: [["'sessionObservation' in host.client && !host.client.sessionObservation().hasSnapshot || host.client.agentSessions().length === 0", 'host.client.agentSessions().length === 0']] },
  'unverified-fence-blocks-exact': { file: controller, pattern: 'control is unverified$',
    changes: [["if (runtimeOwner(host.client) === null) this.assertObservationHostConnection(host.config.id, host)", 'this.assertObservationHostConnection(host.config.id, host)']] },
  'enumerate-caller-inventory': { file: controller, pattern: 'control is confirmed$',
    changes: [["const session = await host.client.readAgentSession(input.agentSessionId)\n      return { host, ownerRuntimeId, owns: session?.hostId === 'local' && session.agentSessionId === input.agentSessionId }",
      "const sessions = await host.client.readAgentSessions()\n      return { host, ownerRuntimeId, owns: sessions.some(session => session.hostId === 'local' && session.agentSessionId === input.agentSessionId) }"]] },
  'clone-cached-inventory': { file: controller, pattern: 'reads only one cached caller hint',
    changes: [['return host.client.agentSession(input.agentSessionId).agentSessionId === input.agentSessionId',
      'return host.client.agentSessions().some(session => session.agentSessionId === input.agentSessionId)']] }
} as const
const mutation = process.env.DESKTOP_DIRECTORY_MUTATION as keyof typeof variants | undefined
if (mutation && !Object.hasOwn(variants, mutation)) throw Error('Unknown Desktop directory mutation')
const owners = new Set(['apps/desktop/src/main/desktop-host.ts', 'apps/desktop/src/main/runtime-controller.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-runtime-service.ts',
  'packages/core/src/client.ts', 'packages/core/src/hosted-value.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-server.ts',
  'packages/core/src/rpc-stream-transport.ts', 'packages/core/test/helpers/public-rpc-owner.ts',
  'apps/desktop/test/hosted-directory-consumers.test.ts', 'apps/desktop/test/launch-smoke-connection.test.ts',
  'apps/desktop/test/main-terminal-input-diagnostics.test.ts', 'apps/desktop/test/toolset-terminal-input-native.test.ts',
  'apps/desktop/test/desktop-host-metadata.test.ts',
  'apps/desktop/test/desktop-host-channel.test.ts'])
export default defineConfig({
  resolve: preparation.resolve, cacheDir: resolve(root, '.tmp/desktop-directory-consumers/cache'),
  plugins: [{ name: 'evaluated-desktop-directory-consumers', enforce: 'pre', transform(code, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!owners.has(file) || !trace) return
    const original = code, selected = mutation ? variants[mutation] : undefined
    if (selected?.file === file) for (const [from, to] of selected.changes) {
      if (code.split(from).length !== 2) throw Error('Desktop directory mutation must match exactly once: ' + mutation)
      code = code.replace(from, to)
    }
    const hash = (value: string) => createHash('sha256').update(value).digest('hex')
    const row = { file, originalSHA256: hash(original), loadedSHA256: hash(code), mutation: code === original ? null : mutation }
    appendFileSync(trace, JSON.stringify({ phase: 'transformed', ...row }) + '\n')
    return code + `\nimport {appendFileSync as __directoryLoaded} from 'node:fs'; __directoryLoaded(${JSON.stringify(trace)},${JSON.stringify(JSON.stringify({ phase: 'evaluated', ...row }) + '\n')});\n`
  } }],
  test: { include: process.env.DESKTOP_DIRECTORY_RELATED ? [
      'apps/desktop/test/launch-smoke-connection.test.ts', 'apps/desktop/test/main-terminal-input-diagnostics.test.ts',
      'apps/desktop/test/toolset-terminal-input-native.test.ts',
      'apps/desktop/test/desktop-host-metadata.test.ts', 'apps/desktop/test/desktop-host-channel.test.ts'
    ] : ['apps/desktop/test/hosted-directory-consumers.test.ts'],
    ...(mutation ? { testNamePattern: variants[mutation].pattern } : process.env.DESKTOP_DIRECTORY_RELATED
      ? { testNamePattern: '^(?!.*prepares the real Desktop channel once)' } : {}), maxWorkers: 1, fileParallelism: false,
    passWithNoTests: false, testTimeout: 15_000, hookTimeout: 15_000 }
})
