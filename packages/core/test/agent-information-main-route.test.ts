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
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { informationNativeFixture } from './fixtures/agent-information-native.mjs'

vi.mock('electron', () => ({ app: { isPackaged: false } }))
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })

it('the production Main route retains the configured remote Host while reading the exact original Core over public RPC', async () => {
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
  expect(f.state.reads).toBe(1); expect(f.state.runtimeWrites).toBe(0)
})
