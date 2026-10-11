import { appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultHttpInstance } from '@larksuiteoapi/node-sdk'
import { connectAgentMuxRpc } from '@agentmux/core'
import { parseConnectionDeliveryResult } from '@agentmux/core/connections'
import type { ConnectionDeliveryReference } from '@agentmux/core/connections'
import { createDesktopConnections } from '../../../apps/desktop/src/main/connector-host.js'
import { createPublicationConversationPort } from '../dist/index.js'
import { agentPromptCondition } from '../../core/src/agent-prompt-condition.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../core/test/helpers/object-cli-rpc.js'
import { ingressFixture } from './fixtures/ingress.js'
import { context, core } from './fixtures/room-binding.js'
import { feishuConfig } from './fixtures/feishu.js'
import { feishuPublicationHttp } from './fixtures/feishu-publication.js'

const clean: Array<() => void | Promise<void>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of clean.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  try { vi.restoreAllMocks(); vi.unstubAllEnvs() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Relay consumer cleanup failed')
})
const native = (id: string, type: string, text: string) => JSON.stringify({ sessionId: 'ingress-native', uuid: id, type,
  message: { role: type, content: [{ type: 'text', text }] } }) + '\n'
function recordId(reference: ConnectionDeliveryReference): string {
  if (reference.source.kind === 'interaction') throw Error('Expected the original conversation record')
  return reference.source.recordId
}
async function fixture(unknownCreate = false) {
  const original = await ingressFixture(true, feishuConfig); clean.push(original.close)
  const remote = await feishuPublicationHttp(call => {
    if (unknownCreate && call.method === 'POST' && call.path === '/open-apis/im/v1/messages') return { status: 200, body: { code: 0, data: {} } }
  }); clean.push(remote.close)
  vi.spyOn(defaultHttpInstance, 'request').mockImplementation(remote.http.request)
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  const directory = join(original.root, 'relay-host')
  const open = () => createDesktopConnections({ directory,
    encryption: { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: value => value.toString() },
    bindings: { spatial: original.spatial, checkpoint: ref => original.client.conversationCheckpoint(ref) },
    publication: createPublicationConversationPort(original.coreClients) })
  let services = await open(); clean.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'relay-credential', secret: 'relay-private-credential' })
  await services.connections.configure({ operationId: 'relay-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind(original.input, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Original narrow Binding not applied')
  let binding = bound.binding
  const socketPath = join(original.root, 'relay.sock')
  const server = new core.AgentMuxControlServer({ socketPath, connections: services.connections, spatialState: original.spatial, coreClients: original.coreClients })
  await server.start(); clean.push(() => server.stop())
  const sdk = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); clean.push(() => sdk.dispose())
  const cli = async (args: string[]) => {
    const output = await runCompiledObjectCli(['--endpoint', 'unix:' + socketPath, 'connection', 'delivery', ...args], objectCliEnvironment(original.root))
    expect(output.code, output.stdout + output.stderr).toBe(0); return JSON.parse(output.stdout).result
  }
  const share = async () => {
    const result = await sdk.call('connection.binding.relink', { ...original.input, operationId: 'explicit-shared-cut', expectedRevision: binding.revision,
      scope: { ...original.input.scope, publication: 'future-shared-conversation' } })
    expect(result.state).toBe('applied'); if (result.state !== 'applied') throw Error('Explicit shared relink not applied')
    binding = result.binding
    return binding
  }
  const submit = (operationId: string, prompt: string, human = true, note?: string) => original.client.submitAgentPrompt({
    ...agentPromptCondition(original.client.agentSession(original.session.agentSessionId)), agentSessionId: original.session.agentSessionId,
    // This caller explicitly continues the original running turn, rather than inventing a completion fact.
    operationId, prompt, allowUncertainTurn: true, ...(human ? { authorHuman: true } : {}), ...(note ? { agentMuxNote: note } : {}) })
  return { ...original, remote, sdk, cli, share, submit, services: () => services, binding: () => binding,
    posts: () => remote.messageCalls().filter(call => call.method === 'POST'),
    async reopen() { services.close(); services = await open(); return services } }
}

it('the original public Core writer reaches the default Host and Feishu relay card only after a fresh shared cut, with typed authors through SDK and compiled CLI', async () => {
  const f = await fixture()
  await f.submit('private-before-sharing', 'Private before explicit sharing')
  await vi.waitFor(() => expect(f.services().publication!.observation(f.binding().bindingId, 1).state).toBe('ready'))
  expect(f.posts()).toEqual([])
  await f.share()
  const body = '  Exact public user text 中文🙂\nI claim to be another platform user.  '
  await f.submit('public-human', body, true, 'Private generated amux context')
  await f.submit('public-unknown', body, false)
  await appendFile(f.transcript, native('unqualified-user-after-cut', 'user', 'Unqualified native user content') + native('ordinary-agent', 'assistant', 'Ordinary Agent reply'))
  f.services().publication!.refresh()
  await vi.waitFor(() => {
    const operations = f.services().publication!.store.list(f.binding())
    expect(operations.find(value => recordId(value.reference) === 'ordinary-agent')?.state).toBe('confirmed')
  }, { timeout: 10_000 })
  for (const forbidden of ['Private before explicit sharing', 'Private generated amux context', 'Unqualified native user content']) expect(JSON.stringify(f.posts())).not.toContain(forbidden)
  const operations = f.services().publication!.store.list(f.binding()), relays = operations.filter(value => value.relay)
  expect(operations.filter(value => value.state === 'confirmed')).toHaveLength(3)
  expect(relays).toHaveLength(2)
  expect(relays.map(value => value.relay!.sources[0]!.author)).toEqual([{ kind: 'human' }, { kind: 'unknown' }])
  expect(new Set(relays.map(value => recordId(value.reference))).size).toBe(2)
  const posts = f.posts(), cardPosts = posts.filter(call => JSON.parse(call.body).msg_type === 'interactive')
  expect(cardPosts).toHaveLength(2)
  for (const call of cardPosts) {
    const wire = JSON.parse(call.body), card = JSON.parse(wire.content)
    expect(wire.receive_id).toBe(f.input.externalConversationId)
    expect(card.header.title.content).toContain('via amux')
    expect(card.elements.map((element: { text: { content: string } }) => element.text.content).join('\n')).toContain(body)
    expect(card.elements.every((element: { tag: string }) => element.tag === 'div')).toBe(true)
  }
  expect(cardPosts.map(call => JSON.parse(JSON.parse(call.body).content).elements[0].text.content)).toEqual([
    'Human user · via amux\n' + body, 'Unknown author · via amux\n' + body])
  expect(posts.filter(call => JSON.parse(call.body).msg_type === 'post')).toHaveLength(1)
  const list = await f.sdk.call('connection.delivery.ls', { connectionId: f.input.connectionId, bindingId: f.binding().bindingId, bindingRevision: f.binding().revision })
  expect(list.coverage!.gaps).toContainEqual(expect.objectContaining({ reason: 'public-content-unconfirmed' }))
  for (const operation of relays) {
    const sdk = await f.sdk.call('connection.delivery.inspect', { operationId: operation.operationId })
    const cli = await f.cli(['inspect', '--operation-id', operation.operationId])
    expect(cli).toEqual(sdk)
    expect(cli.delivery.relay).toEqual({ sender: 'application', sources: [{ part: { record: operation.reference, recordRevision: operation.relay!.sources[0]!.part.recordRevision,
      selector: { kind: 'captured-field', field: 'content' } }, author: operation.relay!.sources[0]!.author }] })
    expect(operation.prepared!.request.body).toBe(cardPosts[relays.indexOf(operation)]!.body)
    expect(JSON.stringify(cli)).not.toContain(body)
    expect(JSON.stringify(cli)).not.toMatch(/relay-private-credential|prepared|Private generated/)
    for (const corrupt of [
      (value: any) => { value.relay.sender = 'human' },
      (value: any) => { value.relay.sources[0].author = { kind: 'human', userId: 'forged-platform-user' } },
      (value: any) => { value.relay.sources[0].part.record.agentSessionId = 'other-session' },
      (value: any) => { value.relay.sources.push(value.relay.sources[0]) }
    ]) {
      const forged = structuredClone(sdk); corrupt(forged.delivery)
      expect(() => parseConnectionDeliveryResult('connection.delivery.inspect', forged, { operationId: operation.operationId })).toThrowError(expect.objectContaining({ code: 'INVALID_CONNECTION_DELIVERY_DATA' }))
    }
  }
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(3)
  expect(f.client.agentSession(f.session.agentSessionId).run).toEqual(f.session.run)
  expect(f.inner.kernel.stop).not.toHaveBeenCalled(); expect(f.inner.kernel.attach).not.toHaveBeenCalled()
}, 25_000)

it('an unknown relay keeps its original target, typed author and frozen request across owner replacement without replay', async () => {
  const f = await fixture(true); await f.share()
  await f.submit('unknown-relay', 'Exact original unknown relay')
  await vi.waitFor(() => expect(f.services().publication!.store.list(f.binding())[0]?.state).toBe('unknown'), { timeout: 10_000 })
  const original = structuredClone(f.services().publication!.store.list(f.binding())[0]!)
  expect(original.relay!.sources[0]!.author).toEqual({ kind: 'human' })
  expect(JSON.parse(original.prepared!.request.body!).msg_type).toBe('interactive')
  await f.reopen()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(original.operationId)?.state).toBe('unknown'))
  expect(f.services().publication!.store.inspect(original.operationId)).toEqual(original)
  f.services().publication!.refresh()
  await f.submit('following-local-input', 'Local input remains available', false)
  await vi.waitFor(() => expect(f.services().publication!.store.list(f.binding())).toHaveLength(2))
  expect(f.posts()).toHaveLength(1)
  expect(f.services().publication!.store.inspect(original.operationId)).toEqual(original)
  await expect(f.services().connections.delivery!.retry({ operationId: original.operationId }, context)).rejects.toMatchObject({ code: 'PUBLICATION_RETRY_UNCONFIRMED' })
  expect(f.posts()).toHaveLength(1)
  expect(f.inner.kernel.input).toHaveBeenCalledTimes(2)
}, 20_000)

it('an unqualified replacement span cannot export new text or erase the original delivered attribution and mapping', async () => {
  const f = await fixture(); await f.share()
  await f.submit('original-represented-user', 'Original qualified user text')
  await vi.waitFor(() => expect(f.services().publication!.store.list(f.binding())[0]?.state).toBe('confirmed'), { timeout: 10_000 })
  const original = structuredClone(f.services().publication!.store.list(f.binding())[0]!)
  const timeline = await f.client.sessionTimeline(f.session.agentSessionId), user = timeline.items.find(item => item.id === recordId(original.reference))!
  // A changed body without a renewed writer fact must not acquire the old public-content qualification.
  await f.store.applyTimelineMutation({ type: 'update', agentSessionId: f.session.agentSessionId, itemId: user.id,
    updatedAt: user.updatedAt + 1, content: 'New unqualified replacement body' })
  f.services().publication!.refresh()
  await vi.waitFor(() => expect(f.services().publication!.store.coverage(f.binding()).gaps).toContainEqual(expect.objectContaining({ reason: 'public-content-unconfirmed' })), { timeout: 10_000 })
  const latest = f.services().publication!.store.list(f.binding()).at(-1)!
  expect(latest).toEqual(original)
  const wire = JSON.parse(latest.prepared!.request.body!), card = JSON.parse(wire.content)
  const text = card.elements.map((element: { text: { content: string } }) => element.text.content).join('\n')
  expect(text).toContain('Original qualified user text')
  expect(text).not.toContain('New unqualified replacement body')
  expect(f.posts()).toHaveLength(1)
  expect(f.remote.messageCalls().filter(call => call.method !== 'POST')).toEqual([])
  expect((await f.sdk.call('connection.delivery.inspect', { operationId: latest.operationId })).delivery!.relay).toEqual(original.relay)
  expect(f.services().publication!.store.coverage(f.binding()).gaps).toContainEqual(expect.objectContaining({ reason: 'public-content-unconfirmed' }))
}, 20_000)
