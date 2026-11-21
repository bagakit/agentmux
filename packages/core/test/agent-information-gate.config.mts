import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import surfaceConfig from '../../../apps/desktop/test/agent-information-surface.config.mts'

const root = resolve(import.meta.dirname, '../../..')
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
/** Exact package exports prevent a sibling worktree's stale dist from satisfying this gate. */
export const agentInformationAliases = ['core', 'providers', 'client-ui', 'browser'].flatMap(name => {
  const manifest = JSON.parse(readFileSync(resolve(root, 'packages', name, 'package.json'), 'utf8'))
  return Object.entries(manifest.exports ?? {}).flatMap(([key, value]) => {
    const entry = value as { import?: string; browser?: string }
    if (!entry.import?.startsWith('./dist/')) return []
    const source = entry.browser?.startsWith('./src/') ? entry.browser : entry.import.replace('./dist/', './src/').replace(/\.js$/u, '.ts')
    return [{ find: new RegExp('^' + escape('@agentmux/' + name + (key === '.' ? '' : key.slice(1))) + '$'),
      replacement: resolve(root, 'packages', name, source) }]
  })
})

export const informationTests = {
  contract: ['packages/core/test/agent-information-contract.test.ts', 'packages/core/test/agent-information-public.test.ts'],
  codex: ['packages/core/test/codex-information.test.ts', 'packages/core/test/codex-information-native.test.ts'],
  claude: ['packages/core/test/claude-information.test.ts', 'packages/core/test/agent-information-contract.test.ts',
    'packages/core/test/agent-information-public.test.ts'],
  surface: ['apps/desktop/test/agent-information-surface.test.tsx', 'packages/core/test/agent-information-main-route.test.ts'],
  integration: ['packages/core/test/agent-information-public.test.ts', 'packages/core/test/codex-information.test.ts',
    'packages/core/test/codex-information-native.test.ts', 'packages/core/test/claude-information.test.ts',
    'packages/core/test/agent-information-contract.test.ts', 'packages/core/test/agent-information-main-route.test.ts', 'apps/desktop/test/agent-information-surface.test.tsx']
} as const

// Mutants are loaded implementation changes. An absent or repeated anchor fails qualification.
export const informationMutations: Record<string, { path: string; before: string; after: string }> = {
  'wrong-native-information': { path: 'packages/core/src/client.ts',
    before: 'if (information.value.nativeSessionId !== handle.sessionId) throw new AgentMuxError(',
    after: 'if (false) throw new AgentMuxError(' },
  'fake-model-ack': { path: 'packages/core/src/agent-configuration.ts',
    before: 'acknowledgement.options.find(option => option.id === configId)?.currentValue !== selection',
    after: 'false' },
  'public-information-detached': { path: 'packages/core/src/client.ts',
    before: 'projected.nativeInformation = structuredClone(information.snapshot)',
    after: 'delete projected.nativeInformation' },
  'surface-old-run-adopted': { path: 'apps/desktop/src/renderer/src/lib/use-agent-native-information.ts',
    before: 'if (!current()) return', after: 'if (false) return' },
  'surface-unknown-ack-applied': { path: 'apps/desktop/src/renderer/src/components/PosturePicker.tsx',
    before: "if (receipt?.outcome === 'applied' && receipt.diskDurability === 'confirmed') { setOperation(undefined); return }",
    after: 'if (receipt) { setOperation(undefined); return }' },
  'surface-remote-host-detached': { path: 'apps/desktop/src/main/runtime-controller.ts',
    before: 'return { ...result, target: { ...result.target, hostId: control.hostId } }', after: 'return result' },
  'codex-native-identity': { path: 'packages/core/src/providers/codex-session-control.ts',
    before: '!isCodexLoadedThread(value, nativeSessionId)', after: 'false' },
  'codex-fake-ack': { path: 'packages/core/src/providers/codex-configuration.ts',
    before: 'if (!after.options.some(option => option.id === request.configId && option.currentValue === request.value)) throw unavailable()',
    after: 'if (false) throw unavailable()' },
  'codex-original-request-id': { path: 'packages/core/src/providers/codex-configuration.ts',
    before: '{ requestId: request.requestId }', after: "{ requestId: 'unrelated-operation' }" },
  'codex-reset-unit': { path: 'packages/core/src/providers/codex-information.ts',
    before: 'resetsAt: window.resetsAt * 1000', after: 'resetsAt: window.resetsAt' },
  'codex-duplicate-dispatch': { path: 'packages/core/src/providers/codex-configuration.ts',
    before: "try { await connection.request('thread/settings/update', { threadId: nativeSessionId, model: request.value }, { requestId: request.requestId }) }",
    after: "try { await connection.request('thread/settings/update', { threadId: nativeSessionId, model: request.value }, { requestId: request.requestId }); await connection.request('thread/settings/update', { threadId: nativeSessionId, model: request.value }, { requestId: request.requestId }) }" },
  'owner-sdk-reference': { path: 'packages/core/src/client.ts',
    before: "return structuredClone<AgentInformationInspection>({ kind: 'information', target, snapshot, configuration: nextConfiguration, ...(issue ? { issue } : {}) })",
    after: "return ({ kind: 'information', target, snapshot, configuration: nextConfiguration, ...(issue ? { issue } : {}) })" },
  'owner-null-retained': { path: 'packages/core/src/client.ts',
    before: 'else this.nativeConfigurations.delete(session.agentSessionId)\n      this.publishSession(current)',
    after: 'else void 0\n      this.publishSession(current)' },
  'owner-newer-ack-erased': { path: 'packages/core/src/client.ts',
    before: 'if (this.nativeConfigurations.get(session.agentSessionId) === previous) {', after: 'if (true) {' },
  'claude-information-detached': { path: 'packages/providers/src/claude/provider.ts',
    before: 'information: claudeNativeInformation,', after: 'information: () => undefined,' },
  'claude-information-repeated': { path: 'packages/providers/src/claude/native-activity.ts',
    before: 'signature === lastInformation', after: 'false' },
  'claude-reset-unit': { path: 'packages/providers/src/claude/native-activity.ts',
    before: 'Date.parse(row.resetsAt)', after: '0' },
  'claude-information-not-saved': { path: 'packages/core/src/client.ts',
    before: 'next.recoveryInformation = { run: next.run, snapshot: information, ...(next.nativeActor ? { actorId: next.nativeActor.actorId } : {}) }',
    after: 'delete next.recoveryInformation' },
  'claude-old-sequence': { path: 'packages/core/src/client.ts',
    before: 'information.sequence >\n          Math.max(previous.snapshot.sequence ?? 0, previous.invalidatedThrough ?? 0)', after: 'true' },
  'claude-gap-ignored': { path: 'packages/core/src/client.ts',
    before: "const fields = [snapshot.model ? 'model' : undefined, snapshot.plan ? 'plan' : undefined, snapshot.limits ? 'limits' : undefined]",
    after: 'const fields = []' }
}
const mode = (process.env.AMX_INFORMATION_MODE ?? 'contract') as keyof typeof informationTests
if (!(mode in informationTests)) throw new Error('Unknown Agent information verification mode: ' + mode)
const mutation = process.env.AMX_INFORMATION_MUTATION
const surface = process.env.AMX_INFORMATION_SURFACE === '1'
const desktopAliases = mode === 'surface' || mode === 'integration'

export default defineConfig({ ...(surface ? surfaceConfig : {}), root,
  resolve: { ...(surface ? surfaceConfig.resolve : {}), alias: [...agentInformationAliases,
    ...(desktopAliases ? surfaceConfig.resolve!.alias as [] : [])] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
  cacheDir: resolve(root, '.local/agent-information/vite-cache'), plugins: [...(surface ? surfaceConfig.plugins ?? [] : []), {
    name: 'agent-information-exact-source', enforce: 'pre', transform(code, id) {
      const file = id.split('?')[0]!, path = relative(root, file)
      const candidate = process.env.AMX_INFORMATION_CANDIDATE
      const compiledPath = candidate ? relative(candidate, file) : undefined
      if (compiledPath && /^(?:core|providers)\/dist\/.+\.js$/u.test(compiledPath)) {
        if (process.env.AMX_INFORMATION_COMPILED_LOADED) appendFileSync(process.env.AMX_INFORMATION_COMPILED_LOADED,
          JSON.stringify({ path: compiledPath, originalSHA256: createHash('sha256').update(readFileSync(file)).digest('hex'),
            sha256: createHash('sha256').update(code).digest('hex'), transform: 'vite' }) + '\n')
        return
      }
      if (!/\.(?:ts|tsx)$/u.test(path) || !['packages/core/src/', 'packages/providers/src/',
        'packages/client-ui/src/', 'apps/desktop/src/'].some(prefix => path.startsWith(prefix))) return
      const original = code, edit = mutation ? informationMutations[mutation] : undefined
      if (mutation && !edit) throw new Error('Unknown Agent information mutation: ' + mutation)
      if (edit?.path === path) {
        if (code.split(edit.before).length !== 2) throw new Error('The mutation must have exactly one source anchor: ' + mutation)
        code = code.replace(edit.before, edit.after)
      }
      if (process.env.AMX_INFORMATION_LOADED) appendFileSync(process.env.AMX_INFORMATION_LOADED,
        JSON.stringify({ path, originalSHA256: createHash('sha256').update(original).digest('hex'),
          sha256: createHash('sha256').update(code).digest('hex'), ...(original === code ? {} : { mutation }) }) + '\n')
      if (original !== code) return { code, map: null }
    }
  }], test: { ...(surface ? surfaceConfig.test : {}), include: [...informationTests[mode]], environment: 'node', setupFiles: [resolve(root, 'vitest.setup.ts')],
    passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 60000, hookTimeout: 15000 } })
