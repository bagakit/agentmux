import { createHash } from 'node:crypto'
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as core from '@agentmux/core'
import * as connectors from '@agentmux/connectors'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { feishuConfig, feishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuMediaPlatform } from '../../../packages/connectors/test/fixtures/feishu-media-platform.js'
import { startAgentMuxHost } from '../src/host.js'

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => {
  try { for (const close of cleanup.splice(0).reverse()) await close() }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs() }
})

it('Mermaid reaches the actual default Node Host, public RPC and SDK without a Desktop, retaining original delivery on reopen', async () => {
  const original = await rpcOwnerFixture(['original-agent'], core, root => ({ providerId: 'claude', executorId: 'claude',
    nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'diagram-native', transcriptPath: join(root, 'native.jsonl') } }))
  cleanup.push(original.close)
  feishuSdkTransport()
  const remote = await feishuMediaPlatform(); cleanup.push(remote.close)
  const transcript = join(original.root, 'native.jsonl'), directory = join(original.root, 'connections'), socket = join(original.root, 'host.sock'), desktop = join(original.root, 'absent-desktop.sock')
  const native = (uuid: string, text: string) => JSON.stringify({ type: 'assistant', sessionId: 'diagram-native', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n'
  await writeFile(transcript, native('before-sharing', 'Private earlier message'))
  await mkdir(directory, { mode: 0o700 }); await original.client.dispose()
  // Observe the real default composition without replacing any connection, renderer or publication owner.
  const factory = connectors.createConnectionServices, opened: connectors.ConnectionServices[] = []
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => { const owner = await factory(options); opened.push(owner); return owner })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner
      await inner.registry.load('local'); inner.connected = true
      for (const key of ['isConnected', 'status', 'identity', 'input', 'observeOutput', 'attach', 'detach', 'stop']) inner.kernel[key] = original.inner.kernel[key]
    })
    try { host = await startAgentMuxHost({ store: original.store, socketPath: socket, desktopSocketPath: desktop,
      mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory } }) }
    finally { connect.mockRestore() }
  }
  const stop = async () => { const previous = host; host = undefined; await previous?.dispose() }; cleanup.push(stop)
  const rpc = () => core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } })
  await start()
  const client = await rpc(); cleanup.push(() => client.dispose())
  const owner = (await client.call('runtime.owner.identity', {})).owner
  const credential = await client.call('connection.credential.store', { operationId: 'diagram-secret', secret: 'synthetic-diagram-secret' },
    { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  await client.call('connection.configure', { operationId: 'diagram-configure', expectedRevision: null, connection: { ...feishuConfig, credentialRef: credential.credentialRef } })
  const bound = await client.call('connection.bind', { operationId: 'diagram-bind', bindingId: 'diagram-binding', connectionId: feishuConfig.connectionId,
    expectedConnectionRevision: 1, executionHostId: 'local', agentSessionId: 'original-agent', externalConversationId: 'original-room',
    expectedSource: { providerId: 'claude', nativeSessionId: 'diagram-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })
  expect(bound.state).toBe('applied'); if (bound.state !== 'applied') throw Error('Original Host binding required')
  const flow = 'flowchart LR\nA[Original message] --> B[Render diagram]\nB --> C[Deliver image]',
    sequence = 'sequenceDiagram\nparticipant User\nparticipant Host\nparticipant Channel\nUser->>Host: Original diagram\nHost->>Channel: Rendered image\nChannel-->>User: Delivery confirmed',
    text = 'Original Host before\n\n```mermaid\n' + flow + '\n```\n\nBetween Host diagrams\n\n```mermaid\n' + sequence + '\n```\n\nOriginal Host after'
  await appendFile(transcript, native('host-diagrams', text))
  const service = () => opened.at(-1)!, operations = () => service().publication!.store.list(bound.binding).filter(operation => operation.payload.kind !== 'binding-lifecycle')
  await vi.waitFor(() => {
    expect(remote.uploads).toHaveLength(2)
    expect(operations()).toHaveLength(5)
    expect(operations().every(operation => operation.state === 'confirmed')).toBe(true)
  }, { timeout: 30_000 })
  const images = operations().filter(operation => operation.payload.kind === 'image'), receipts = []
  vi.stubEnv('AGENTMUX_TEST_OBJECT_CLI', resolve('packages/core/bin/amux'))
  for (const [index, operation] of images.entries()) {
    if (operation.payload.kind !== 'image') throw Error('Original derived image required')
    expect(remote.uploads[index]).toEqual(Buffer.from(operation.payload.image.dataBase64, 'base64'))
    const receipt = await client.call('connection.delivery.inspect', { operationId: operation.operationId })
    expect(receipt.delivery).toMatchObject({ state: 'confirmed', resourceUpload: { kind: 'image', state: 'confirmed', attempt: 1 } })
    const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + socket, 'connection', 'delivery', 'inspect', '--operation-id', operation.operationId], objectCliEnvironment(original.root))
    expect(cli.code, cli.stdout + cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(receipt)
    receipts.push(receipt)
  }
  await expect(stat(desktop)).rejects.toMatchObject({ code: 'ENOENT' })
  const before = operations(), requests = remote.calls.filter(call => call.method === 'POST').length
  await client.dispose(); await stop(); await start()
  const reopened = await rpc(); cleanup.push(() => reopened.dispose())
  const nextOwner = (await reopened.call('runtime.owner.identity', {})).owner
  expect(nextOwner.runtimeId).toBe(owner.runtimeId); expect(nextOwner.ownerInstanceId).not.toBe(owner.ownerInstanceId)
  expect(operations()).toEqual(before)
  await appendFile(transcript, native('after-reopen', 'New original Host message after reopening'))
  await vi.waitFor(() => expect(JSON.stringify(remote.calls)).toContain('New original Host message after reopening'), { timeout: 15_000 })
  expect(remote.uploads).toHaveLength(2)
  expect(remote.calls.filter(call => call.method === 'POST')).toHaveLength(requests + 1)
  for (const [index, operation] of images.entries()) expect(await reopened.call('connection.delivery.inspect', { operationId: operation.operationId })).toEqual(receipts[index])
  expect(JSON.stringify(remote.calls)).not.toContain('Private earlier message')
  expect(original.inner.kernel.input).not.toHaveBeenCalled(); expect(original.inner.kernel.stop).not.toHaveBeenCalled()
  if (process.env.MERMAID_IMAGE_OUTPUT) {
    await mkdir(process.env.MERMAID_IMAGE_OUTPUT, { recursive: true })
    for (const [index, bytes] of remote.uploads.entries()) await writeFile(join(process.env.MERMAID_IMAGE_OUTPUT, index ? 'host-sequence.png' : 'host-flowchart.png'), bytes)
  }
  if (process.env.MERMAID_HOST_FACTS) await writeFile(process.env.MERMAID_HOST_FACTS, JSON.stringify({
    schema: 'agentmux.default-host-mermaid-consumer.v1', platform: process.platform, node: process.version,
    scope: 'Actual startAgentMuxHost, Core/native transcript, public Unix RPC and compiled CLI, private SQLite, default adapters and official multipart SDK. Only Runtime connectivity and platform IO controlled; no Desktop, live account or remote machine.',
    sameRuntimeId: true, newOwnerInstance: true, sameOriginalDeliveries: true, repeatedUploads: 0, desktopAbsent: true,
    images: images.map((operation, index) => ({ operationId: operation.operationId, sha256: createHash('sha256').update(remote.uploads[index]!).digest('hex'), derivation: operation.payload.kind === 'image' ? operation.payload.image.derivation : null })), receipts
  }, null, 2) + '\n')
}, 45_000)
