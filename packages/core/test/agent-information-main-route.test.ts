import { fixtureEpoch } from '../../../test/fixture-values.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import { AgentMuxError } from '../src/errors.js'
import type { AgentConfigurationSet } from '../src/agent-configuration.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { informationNativeFixture } from './fixtures/agent-information-native.mjs'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const owningMode = ['surface', 'integration'].includes(process.env.AMX_INFORMATION_MODE ?? '') ||
  ['surface', 'integration'].includes(process.env.AMX_MODEL_SYNC_MODE ?? '')

// A default repository collection has no private compiled listener asset. Owning gates must provide it;
// their missing candidate still fails below rather than producing a skipped-only green result.
it.skipIf(!owningMode && !process.env.AMX_INFORMATION_CANDIDATE)('the production Main route retains the configured remote Host while reading the exact original Core over public RPC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'amx-information-route-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  const f = await informationNativeFixture({ AgentMuxClient, AgentMuxFileAgentSessionStore, defineAgentProvider, AgentMuxError }, root)
  cleanup.push(f.close)
  const candidate = process.env.AMX_INFORMATION_CANDIDATE
  if (!candidate) throw new Error('The actual Main route requires the same-source compiled Control listener asset.')
  await import(/* @vite-ignore */ pathToFileURL(resolve(import.meta.dirname, 'fixtures/agent-information-loader.mjs')).href)
  const { AgentMuxControlServer } = await import(/* @vite-ignore */ pathToFileURL(join(candidate, 'core/dist/public-rpc-server.js')).href)
  const server = new AgentMuxControlServer({ socketPath: join(root, 'information.sock'), coreClients: () => [{ hostId: 'local', client: f.client }] })
  await server.start(); cleanup.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  cleanup.push(() => rpc.dispose())
  const requests: Array<{ method: string; params: unknown }> = [], route = 'configured-remote-original'
  const { RuntimeController } = await import('../../../apps/desktop/src/main/runtime-controller.js')
  const receiver = {
    trackHostOperation: async (hostId: string, call: () => Promise<unknown>) => { expect(hostId).toBe(route); return await call() },
    connectedClient: async (hostId: string) => {
      expect(hostId).toBe(route)
      return { forwardRpc: async (method: any, params: any, context: any) => {
        requests.push({ method, params }); return await rpc.call(method, params, context)
      } }
    }
  }
  const control = { kind: 'agent' as const, hostId: route, agentSessionId: f.id, run: { runId: f.runId } }
  const result = await RuntimeController.prototype.inspectInformation.call(receiver as any, control)
  expect(requests).toEqual([{ method: 'agent.information.inspect', params: f.input }])
  expect(result).toMatchObject({ kind: 'information', target: { hostId: route, runtimeId: 'information-runtime-original',
    agentSessionId: f.id, expectedRun: { runId: f.runId }, providerId: 'information-fixture' },
    snapshot: { nativeSessionId: f.nativeId, observedAt: fixtureEpoch(2, 0, 123), model: { id: 'model-small' } } })
  expect(f.state.reads).toBe(1); expect(f.state.configurations).toBe(0); expect(f.state.runtimeWrites).toBe(0)

  const configuration = await RuntimeController.prototype.inspectConfiguration.call(receiver as any, control)
  expect(configuration).toMatchObject({ kind: 'configuration', target: result.target,
    snapshot: { revision: 'revision-model-small', options: [{ id: 'model', category: 'model', currentValue: 'model-small' }] } })
  if (configuration.kind !== 'configuration' || !configuration.snapshot) throw new Error('The original Core did not return a configuration target.')
  expect(requests).toEqual([{ method: 'agent.information.inspect', params: f.input },
    { method: 'agent.configuration.inspect', params: f.input }])
  expect(f.state.reads).toBe(1); expect(f.state.configurations).toBe(1)

  const request: AgentConfigurationSet = { target: configuration.target, operationId: 'main-route-model-original',
    expectedRevision: configuration.snapshot.revision, configId: 'model', value: 'model-large' }
  const applied = await RuntimeController.prototype.setConfiguration.call(receiver as any, control, request)
  expect(applied).toMatchObject({ operationId: request.operationId, target: configuration.target, outcome: 'applied',
    acknowledgement: { revision: 'revision-model-large', options: [{ id: 'model', currentValue: 'model-large' }] } })
  expect(requests.slice(2)).toEqual([{ method: 'agent.configuration.set', params: { ...request,
    target: { ...configuration.target, hostId: 'local' } } }])
  expect(request.target.hostId).toBe(route)
  expect(f.state.writes).toHaveLength(1)
  expect(f.state.reads).toBe(1); expect(f.state.configurations).toBe(1)

  const operation = await RuntimeController.prototype.inspectConfiguration.call(receiver as any, control, request.operationId)
  expect(operation).toMatchObject({ kind: 'operation', agentSessionId: f.id, operationId: request.operationId,
    operation: applied })
  expect(requests.at(-1)).toEqual({ method: 'agent.configuration.inspect', params: { hostId: 'local',
    agentSessionId: f.id, operationId: request.operationId } })
  expect(f.state.writes).toHaveLength(1)
  expect(f.state.reads).toBe(1); expect(f.state.configurations).toBe(1)

  const beforeRefusal = requests.length
  for (const target of [{ ...request.target, hostId: 'foreign-host' }, { ...request.target, agentSessionId: 'foreign-session' },
    { ...request.target, expectedRun: { runId: 'foreign-run' } }]) {
    await expect(RuntimeController.prototype.setConfiguration.call(receiver as any, control, { ...request, target })).rejects.toMatchObject({
      code: 'INVALID_CONTROL_REQUEST', controlFailure: { disposition: 'not_applied', confirmedInputBytes: 0 } })
  }
  expect(requests).toHaveLength(beforeRefusal)
  expect(f.state.writes).toHaveLength(1); expect(f.state.runtimeWrites).toBe(0)
})
