import { join, resolve } from 'node:path'
import { appendFile } from 'node:fs/promises'
import { afterEach, expect, vi } from 'vitest'
import type { PublicationOperation, PublicationStore } from '../../src/publication-store.js'
import { feishuMediaPlatform } from './feishu-media-platform.js'
import * as core from '../../../core/dist/index.js'
import { createPublicationConversationPort } from '../../src/index.js'
import { createConnectionServices } from '../../src/connection-services.js'
import { ingressFixture } from './ingress.js'
import { feishuConfig } from './feishu.js'
import { context } from './room-binding.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../core/test/helpers/object-cli-rpc.js'

export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII=', 'base64')
export const reference = 'data:image/png;base64,' + png.toString('base64')
export const closes: Array<() => unknown | Promise<unknown>> = []
export const retryRequest = (operation: PublicationOperation) => ({ operationId: operation.operationId, source: { kind: operation.attempt === undefined ? 'content-upload' as const : 'message' as const, attempt: operation.attempt ?? operation.uploads?.length ?? 1 } })
export const contentOperations = (store: PublicationStore, ...args: Parameters<PublicationStore['list']>) =>
  store.list(...args).filter(operation => operation.payload.kind !== 'binding-lifecycle')
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of closes.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  if (errors.length) throw new AggregateError(errors, 'Recorded image consumer cleanup failed')
})


export async function fixture(scope: 'future-shared-conversation' | 'future-native-user-facing' = 'future-shared-conversation') {
  const original = await ingressFixture(false, feishuConfig, undefined, { publication: 'future-shared-conversation' }); closes.push(original.close)
  const remote = await feishuMediaPlatform(), port = createPublicationConversationPort(original.coreClients)
  closes.push(remote.close)
  const openServices = () => createConnectionServices({ directory: join(original.root, 'image-host'),
    bindings: { spatial: original.spatial, checkpoint: ref => original.client.conversationCheckpoint(ref) }, publication: port })
  let services = await openServices()
  closes.push(() => services.close())
  const credential = await services.secrets.store({ operationId: 'image-credential', secret: 'fixture-image-credential' })
  await services.connections.configure({ operationId: 'image-configuration', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await services.connections.bindings!.bind({ ...original.input, scope: { ...original.input.scope, publication: scope } }, context)
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw new Error('Original image sharing Binding required')
  let ownerInstanceId = 'original-image-owner'
  const runtime = new core.AgentMuxHostedRuntimeService(original.client, null, () => ({ runtimeId: 'original-image-runtime', ownerInstanceId,
    protocolVersion: 2, processId: process.pid, availability: 'connected', ctxmux: null }))
  closes.push(() => runtime.dispose())
  const server = new core.AgentMuxControlServer({ socketPath: join(original.root, 'images.sock'), connections: new Proxy({} as typeof services.connections, { get: (_target, key) => Reflect.get(services.connections, key) }), spatialState: original.spatial, coreClients: original.coreClients, hostedRuntime: () => runtime })
  await server.start(); closes.push(() => server.stop())
  const rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const managed = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path }, credentials: original.credentials }); closes.push(() => managed.dispose())
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', process.env.AGENTMUX_TEST_OBJECT_CLI ?? resolve('packages/core/bin/amux'))
  const retryCli = (input: ReturnType<typeof retryRequest>) => runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'retry', '--input', '-'],
    objectCliEnvironment(original.root, { AGENTMUX_AGENT_SESSION_ID: original.credentials.agentSessionId, AGENTMUX_AGENT_CAPABILITY: original.credentials.capability }), JSON.stringify(input))
  const cli = async (operationId: string) => {
    const result = await runCompiledObjectCli(['--endpoint', 'unix:' + server.path, 'connection', 'delivery', 'inspect', '--operation-id', operationId], objectCliEnvironment(original.root))
    expect(result.code, result.stderr).toBe(0); return JSON.parse(result.stdout).result
  }
  return { ...original, remote, get services() { return services }, runtime, replaceRuntime() { ownerInstanceId = 'replacement-image-owner' }, port, binding: bound.binding, rpc, managed, cli, retryCli,
    async restart() { await services.close(); services = await openServices(); closes.push(() => services.close()); return services } }
}

export const imageBlock = () => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } })
export const native = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({ sessionId: 'ingress-native', uuid, type: 'assistant', message: { role: 'assistant', content }, ...extra })
export const append = (f: Awaited<ReturnType<typeof fixture>>, record: unknown) => appendFile(f.transcript, JSON.stringify(record) + '\n')
export const contentMessage = (message: Record<string, unknown>) => message.msg_type === 'interactive' &&
  JSON.parse((message.body as { content: string }).content).header?.title?.content !== 'Conversation connected'
export const posts = (f: Awaited<ReturnType<typeof fixture>>) => f.remote.calls.filter(call => call.method === 'POST' &&
  (call.body as { msg_type: string }).msg_type === 'interactive' && JSON.parse((call.body as { content: string }).content).header?.title?.content !== 'Conversation connected')
export const imageWrites = (f: Awaited<ReturnType<typeof fixture>>) => f.remote.calls.filter(call => ['POST', 'PATCH'].includes(call.method) && JSON.stringify(call.body).includes('img_key'))
export const imageOperation = (f: Awaited<ReturnType<typeof fixture>>) => contentOperations(f.services.publication!.store, f.binding).find(operation => operation.payload.kind === 'image')
