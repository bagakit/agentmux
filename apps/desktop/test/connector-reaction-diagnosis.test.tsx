// @vitest-environment happy-dom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { ingressFixture } from '../../../packages/connectors/test/fixtures/ingress'
import { PublicationHost } from '../../../packages/connectors/src/publication-host'
import { createPublicationConversationPort } from '../../../packages/connectors/src/core-conversation-port'
import { queueQueryFeedback } from '../../../packages/connectors/src/publication-query-feedback'
import type { PublicationOperation } from '../../../packages/connectors/src/publication-store'
import { AgentMuxControlServer } from '../../../packages/core/src/public-rpc-server'
import { connectAgentMuxRpc } from '../../../packages/core/src/public-rpc-client'
import { parseConnectionResult, formatGroupDiagnosis } from '../../../packages/core/src/connections'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc'
import { registerConnectorIpc } from '../src/main/connector-ipc'
import { unwrapSessionInputOperationResult } from '../src/shared/session-input-result'
import { ConnectorDeliveryDetails } from '../src/renderer/src/components/ConnectorDeliveryDetails'
import { api } from '../src/renderer/src/lib/api'
import { composerDOM } from './helpers/composer-dom-fixture'

const dom = composerDOM(),
  closes: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  await dom.render(null)
  for (const close of closes.splice(0).reverse()) await close()
})
const wait = async (assertion: () => void | Promise<void>) =>
  vi.waitFor(
    async () => {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10))
      })
      await assertion()
    },
    { timeout: 6000 }
  )

/** Real Outbox and publication read port → Core safe RPC/codec → compiled CLI and mounted IPC consumer.
 * Ingress transport, original native source page and platform receipts are controlled, not live effects. */
async function fixture() {
  const f = await ingressFixture()
  closes.push(() => f.close())
  const publication = new PublicationHost({
    connections: f.connections,
    bindings: f.bindings,
    conversation: createPublicationConversationPort(() => [{ hostId: 'local', client: f.client }])
  })
  closes.push(() => publication.close())
  f.connections.delivery = publication
  const binding = (await f.bindings.inspect({ bindingId: f.input.bindingId })).binding!
  const received = await f.receive({ conversationKind: 'group' }),
    query = (await f.ingress.dispatch(received.ingress.ingressId)).ingress!
  if (query.kind === 'action') throw Error('Original message fixture required')
  publication.store.queueQueryReceived(binding, query)
  const preparer = {
    adapterId: 'fixture',
    renderVersion: 'fixture-v1',
    supportedRenderVersions: ['fixture-v1'],
    prepare: (operation: PublicationOperation) => ({
      adapterId: 'fixture',
      renderVersion: 'fixture-v1',
      requestKey: operation.operationId,
      request: { method: 'POST' as const, path: '/original', body: '{}' }
    })
  }
  const settle = (operation: PublicationOperation, unknown = false) => {
    const claimed = publication.store.claimNext(binding, operation.operationId, () => true, preparer)!
    expect(claimed).toBeTruthy()
    return publication.store.settle(
      claimed.operationId,
      claimed.attempt!,
      unknown
        ? { state: 'unknown', reason: 'effect-unconfirmed' }
        : {
            state: 'confirmed',
            mapping: operation.queryFeedback
              ? { messageId: operation.queryFeedback.messageId, reactionId: 'reaction-' + operation.operationId }
              : { messageId: 'original-platform-' + operation.operationId }
          }
    )
  }
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'reaction-diagnosis.sock'), connections: f.connections, coreClients: f.coreClients })
  await server.start()
  closes.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } })
  closes.push(() => sdk.dispose())
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>(),
    hostingTarget = { hostId: 'local', runtimeId: 'original-owner' }
  registerConnectorIpc({
    handleWithEvent: (name, handler) => {
      handlers.set(name, handler)
    },
    assertTrusted: vi.fn(),
    metadata: { publish() {}, observation() {} },
    runtime: {
      connectionHostingTarget: async () => hostingTarget,
      callConnectionHost: async (target, method, input) => {
        expect(target).toEqual(hostingTarget)
        return sdk.call(method, input)
      },
      watchConnectionMetadata: async (_target, handlers) => sdk.subscribe('connection.metadata.watch', {}, handlers)
    }
  })
  vi.spyOn(api.connections, 'call').mockImplementation(async (method, params, target) =>
    unwrapSessionInputOperationResult(structuredClone(await handlers.get('connections:call')!({}, method, params, target)) as any)
  )
  const target = { executionHostId: 'local', agentSessionId: binding.agentSessionId, bindingId: binding.bindingId, bindingRevision: binding.revision }
  const report = () => sdk.call('connection.diagnose', target)
  const cli = async () => {
    const output = await runCompiledObjectCli(
      [
        '--endpoint',
        'unix:' + server.path,
        'connection',
        'diagnose',
        '--host',
        'local',
        '--session',
        binding.agentSessionId,
        '--binding',
        binding.bindingId,
        '--revision',
        String(binding.revision)
      ],
      objectCliEnvironment(f.root)
    )
    expect(output.code, output.stdout + output.stderr).toBe(0)
    return output.stdout
  }
  const mount = async () => {
    await dom.render(<ConnectorDeliveryDetails binding={binding} hostingTarget={hostingTarget} />)
    await wait(() => expect(dom.container.querySelector('[data-direction="outgoing"]')).not.toBeNull())
  }
  return { ...f, publication, binding, query, settle, sdk, target, report, cli, mount }
}

it('keeps a reaction-only original Outbox visible through safe RPC and compiled CLI without claiming conversation delivery in the mounted summary', async () => {
  const f = await fixture(),
    original = f.publication.store.queryReceived(f.binding, f.query.ingressId)!
  f.settle(original)
  await f.mount()
  await wait(() => expect(dom.container.querySelector('[data-direction="outgoing"]')?.textContent).toContain('1 message status update confirmed'))
  expect(dom.container.querySelector('[data-direction="outgoing"]')?.textContent).not.toContain('conversation update')
  expect(dom.container.textContent).toContain('Message status update · Queue: confirmed')
  const report = await f.report(),
    group = report.groups.value!.items[0]!
  expect(group.outgoing.value!.deliveries).toMatchObject([{ kind: 'query-feedback', operationId: original.operationId, receipt: 'confirmed' }])
  expect(parseConnectionResult('connection.diagnose', report, f.target)).toEqual(report)
  expect(formatGroupDiagnosis({ ...group, service: report.service })).toContain('query-feedback')
  expect(await f.cli()).toContain('query-feedback')
  for (const value of [f.query.body, 'queryPending', 'queryTurn', 'payload', 'credentialRef']) expect(JSON.stringify(report)).not.toContain(value)
}, 25000)

it('counts only original speech in a mixed receipt window and retains pending feedback plus unknown effects and source observations', async () => {
  const f = await fixture(),
    store = f.publication.store
  f.settle(store.queryReceived(f.binding, f.query.ingressId)!)
  const checkpoint = store.checkpoint(f.binding, 'local')
  await appendFile(
    f.transcript,
    JSON.stringify({
      type: 'assistant',
      sessionId: 'ingress-native',
      uuid: 'original-public-reply',
      message: { role: 'assistant', content: [{ type: 'text', text: 'PRIVATE original public speech' }] }
    }) + '\n'
  )
  const page = await f.client.readConversationChanges({ hostId: 'local', agentSessionId: f.binding.agentSessionId, checkpoint })
  store.commitPage(f.binding, checkpoint, page, () => true, {
    units: page.items.flatMap((item) => (item.kind === 'item' ? [item.item] : [])),
    resolvedText: new Map()
  })
  const speech = store.list(f.binding).find((value) => value.payload.kind === 'speech')!
  expect(speech).toBeTruthy()
  f.settle(speech)
  queueQueryFeedback(store, f.binding, f.query, 'queued')
  const queued = store.list(f.binding).find((value) => value.queryFeedback?.stage === 'queued')!
  f.settle(queued, true)
  queueQueryFeedback(store, f.binding, f.query, 'dispatched')
  await f.mount()
  await wait(() =>
    expect(dom.container.querySelector('[data-direction="outgoing"]')?.textContent).toContain(
      '1 conversation update delivered · 1 message status update confirmed'
    )
  )
  expect(dom.container.textContent).toContain('Message status update · Queue: unknown')
  expect(dom.container.textContent).toContain('Message status update · Queue: pending')
  const report = await f.report(),
    group = report.groups.value!.items[0]!
  expect(group.outgoing.value!.deliveries.filter((value) => value.kind === 'conversation')).toHaveLength(1)
  expect(group.outgoing.value!.deliveries.filter((value) => value.kind === 'query-feedback')).toHaveLength(3)
  expect(group.outgoing.value!.effectObservation?.state).toBe('unknown')
  // No publication adapter is configured: source observation is not forged ready by receipt success.
  expect(group.outgoing.value!.sourceObservation?.state).not.toBe('ready')
  expect(dom.container.textContent).toContain('Source reading unconfirmed')
  const cli = JSON.parse(await f.cli()).result
  expect(cli.groups.value.items[0].outgoing.value.deliveries.filter((value: any) => value.kind === 'query-feedback')).toHaveLength(3)
  expect(cli.groups.value.items[0].outgoing.value.deliveries.filter((value: any) => value.kind === 'conversation')).toHaveLength(1)
  expect(JSON.stringify(report)).not.toContain('PRIVATE original public speech')
}, 25000)
