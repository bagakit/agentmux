import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { agentInformationAliases, informationMutations } from './agent-information-gate.config.mts'
import surfaceConfig from '../../../apps/desktop/test/agent-information-surface.config.mts'
import { instrumentModelStateNativeRpc } from './fixtures/model-state-native-trace.mjs'

const root = resolve(import.meta.dirname, '../../..')
export const modelStateTests = {
  native: ['packages/core/test/model-state-core.test.ts', 'packages/core/test/model-state-public.test.ts',
    'packages/core/test/codex-information.test.ts', 'packages/core/test/codex-configuration-observation.test.ts',
    'packages/core/test/codex-model-state-sync-native.test.ts', 'packages/core/test/provider-acp-actor.integration.test.ts'],
  surface: ['packages/core/test/model-state-main-route.test.ts', 'apps/desktop/test/agent-information-surface.test.tsx'],
  integration: ['packages/core/test/model-state-core.test.ts', 'packages/core/test/model-state-public.test.ts',
    'packages/core/test/codex-information.test.ts', 'packages/core/test/codex-configuration-observation.test.ts',
    'packages/core/test/provider-acp-actor.integration.test.ts', 'packages/core/test/model-state-main-route.test.ts',
    'apps/desktop/test/agent-information-surface.test.tsx', 'packages/core/test/agent-information-contract.test.ts',
    'packages/core/test/agent-information-public.test.ts', 'packages/core/test/agent-information-main-route.test.ts']
} as const

export const modelStateDependencies = ['packages/core/test/agent-information-gate.config.mts',
  'packages/core/test/fixtures/agent-information-loader.mjs', 'packages/core/test/fixtures/agent-information-native.mjs',
  'packages/core/test/fixtures/agent-information-owner.mjs', 'packages/core/test/codex-information-native.test.ts',
  'packages/core/test/fixtures/codex-information-native-owner.mjs',
  'packages/core/test/fixtures/model-state-native-trace.mjs', 'packages/core/test/fixtures/model-state-owner.mjs',
  'packages/core/test/fixtures/model-state-main-bridge.mjs', 'packages/core/test/fixtures/model-state-main-owner.mjs',
  'packages/core/test/fixtures/model-state-child.mjs', 'packages/core/test/fixtures/codex-model-state-native.mjs',
  'packages/core/test/fixtures/codex-model-state-native-check.mjs', 'packages/core/test/helpers/codex-offline-endpoint.ts',
  'packages/core/test/helpers/object-cli-rpc.ts', 'packages/core/test/helpers/fixture-values.ts',
  'packages/core/test/helpers/headless-runtime-fixture.ts', 'apps/desktop/test/helpers/model-state-main-client.ts',
  'apps/desktop/src/renderer/src/lib/terminal-capability-replies.ts',
  'apps/host/test/mobile-web-node-loader.mjs', 'apps/host/test/mote-presence-node-loader.mjs',
  'apps/host/test/mobile-goals-mutations.mjs', 'apps/host/test/mobile-diagnostics-mutations.mjs',
  'apps/host/test/mobile-creation-mutations.mjs', 'apps/host/test/mobile-content-mutations.mjs',
  'apps/host/test/mobile-workspace-mutations.mjs', 'apps/host/test/mobile-discovery-mutations.mjs',
  'apps/host/test/mote-presence-mutations.mjs', 'apps/host/test/mote-reliability-mutations.mjs',
  'packages/core/test/codex-model-state-sync-native.test.ts',
  'packages/core/test/fixtures/acp-spatial-host.mjs', 'packages/core/test/fixtures/acp-spatial-host-loader.mjs',
  'packages/core/test/fixtures/acp-run-cli.mjs',
  'apps/desktop/test/agent-information-surface.config.mts', 'apps/desktop/test/vitest.ui-controls-owning.config.mts',
  'apps/desktop/scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts']

export type ModelStateMutation = { path: string; before: string; after: string; tests: readonly string[]; name?: string;
  compiled?: { path: string; before: string; after: string } }
const core = ['packages/core/test/model-state-core.test.ts']
const provider = ['packages/core/test/codex-configuration-observation.test.ts']
const surface = ['apps/desktop/test/agent-information-surface.test.tsx']
export const modelStateMutations: Record<string, ModelStateMutation> = {
  'core-old-sequence': { path: 'packages/core/src/client.ts',
    before: 'if (observation.sequence <= (watch.sequence ?? 0)) return', after: 'if (false) return', tests: core,
    name: 'foreign native samples and older sequences' },
  'core-gap-watermark': { path: 'packages/core/src/client.ts',
    before: 'if (source) watch.sequence = source.sequence', after: 'if (false) watch.sequence = source!.sequence', tests: core,
    name: 'a source gap preserves the original sample clock' },
  'core-transcript-discovery-refused': { path: 'packages/core/src/client.ts',
    before: "if (!matchesProviderNativeSessionTarget(session.nativeHandle, current.nativeHandle) || !isDeepStrictEqual(current.nativeActor, actor)) throw new AgentMuxError('The original configuration source changed.'",
    after: "if (!sameNativeHandle(session.nativeHandle, current.nativeHandle) || !isDeepStrictEqual(current.nativeActor, actor)) throw new AgentMuxError('The original configuration source changed.'",
    tests: core, name: 'a cold configuration read accepts original transcript discovery' },
  'native-early-push-barrier': { path: 'packages/core/src/providers/codex-managed-frontend.ts',
    before: 'if (packet.configurationBarrier !== true) return false', after: 'if (false) return false', tests: provider,
    name: 'a one-shot source barrier ignores interleaved pushes' },
  'native-obsolete-read': { path: 'packages/core/src/providers/codex-configuration-source.ts',
    before: 'if (requested !== demand) continue', after: 'if (false) continue', tests: provider,
    name: 'a finite burst of native invalidations coalesces' },
  'native-late-provider': { path: 'packages/core/src/providers/codex-configuration.ts',
    before: 'connection.configurationSource(current).sourceId !== before.observation?.sourceId', after: 'false',
    tests: ['packages/core/test/codex-information.test.ts'], name: 'a late provider change with the same model string' },
  'native-producer-detached': { path: 'packages/core/src/providers/codex-managed-run.ts',
    before: 'configuration.invalidate()', after: 'void 0', tests: surface,
    name: 'the same physical native TUI and original Core Session converge in both directions through the actual Composer',
    compiled: { path: 'core/dist/providers/codex-managed-run.js', before: 'configuration.invalidate();', after: 'void 0;' } },
  'surface-account-read': { path: 'apps/desktop/src/renderer/src/lib/use-agent-native-configuration.ts',
    before: 'const result = await api.sessions.inspectConfiguration(control)', after: 'const result = await api.sessions.inspectInformation(control)',
    tests: surface, name: 'the real visible Composer reads model configuration without reading account information' },
  'surface-lost-original-operation': { path: 'apps/desktop/src/renderer/src/store.ts',
    before: 'catch (error) { throw new AgentConfigurationRequestError(original, error) }', after: 'catch (error) { throw error }',
    tests: surface, name: 'transport failure without a receipt retains the minted operation and full target' },
  'surface-push-disconnected': { ...informationMutations['surface-push-disconnected'],
    tests: surface, name: 'older native reads cannot overwrite same-clock Core configuration revisions' }
}
export const modelStateMutationSets: Record<keyof typeof modelStateTests, string[]> = {
  native: ['core-old-sequence', 'core-gap-watermark', 'core-transcript-discovery-refused', 'native-early-push-barrier', 'native-obsolete-read', 'native-late-provider'],
  surface: ['surface-account-read', 'surface-lost-original-operation', 'surface-push-disconnected'],
  integration: ['native-producer-detached', 'core-old-sequence', 'surface-push-disconnected']
}

const mode = (process.env.AMX_MODEL_SYNC_MODE ?? 'native') as keyof typeof modelStateTests
if (!(mode in modelStateTests)) throw new Error('Unknown model-state verification mode: ' + mode)
const renderer = process.env.AMX_MODEL_SYNC_RENDERER === '1'
const mutation = process.env.AMX_MODEL_SYNC_MUTATION
const hash = (value: string) => createHash('sha256').update(value).digest('hex')
export default defineConfig({ ...(renderer ? surfaceConfig : {}), root,
  resolve: { ...(renderer ? surfaceConfig.resolve : {}), alias: [...agentInformationAliases, ...surfaceConfig.resolve!.alias as []] },
  define: { __AGENTMUX_WEB_PREVIEW__: 'true' }, cacheDir: resolve(root, '.local/model-state-sync/vite-cache'),
  plugins: [...(renderer ? surfaceConfig.plugins ?? [] : []), {
    name: 'model-state-loaded-source', enforce: 'pre', transform(code, id) {
      const file = id.split('?')[0]!, path = relative(root, file), candidate = process.env.AMX_INFORMATION_CANDIDATE
      const compiled = candidate ? relative(candidate, file) : undefined
      if (compiled && /^(?:core|providers)\/dist\/.+\.js$/u.test(compiled)) {
        if (process.env.AMX_INFORMATION_COMPILED_LOADED) appendFileSync(process.env.AMX_INFORMATION_COMPILED_LOADED,
          JSON.stringify({ path: compiled, originalSHA256: hash(readFileSync(file, 'utf8')), sha256: hash(code), transform: 'vite' }) + '\n')
        return
      }
      if (!/\.(?:ts|tsx)$/u.test(path) || !['packages/core/src/', 'packages/providers/src/',
        'packages/client-ui/src/', 'apps/desktop/src/'].some(prefix => path.startsWith(prefix))) return
      const original = code, edit = mutation ? modelStateMutations[mutation] : undefined
      if (mutation && !edit) throw new Error('Unknown model-state mutation: ' + mutation)
      if (edit?.path === path) {
        if (code.split(edit.before).length !== 2) throw new Error('The model-state mutant requires one actual source anchor: ' + mutation)
        code = code.replace(edit.before, edit.after)
      }
      const instrumented = path === 'packages/providers/src/codex/native-rpc.ts' && Boolean(process.env.AMX_MODEL_SYNC_NATIVE_TRACE)
      if (instrumented) code = instrumentModelStateNativeRpc(code, process.env.AMX_MODEL_SYNC_NATIVE_TRACE)
      if (process.env.AMX_MODEL_SYNC_LOADED) appendFileSync(process.env.AMX_MODEL_SYNC_LOADED,
        JSON.stringify({ path, originalSHA256: hash(original), sha256: hash(code),
          ...(edit?.path === path ? { mutation } : {}), ...(instrumented ? { instrumentation: 'native-rpc-frame-trace' } : {}) }) + '\n')
      if (code !== original) return { code, map: null }
    }
  }], test: { ...(renderer ? surfaceConfig.test : {}), include: [...modelStateTests[mode]], environment: renderer ? 'happy-dom' : 'node',
    setupFiles: [resolve(root, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false,
    testTimeout: 60000, hookTimeout: 15000 } })
