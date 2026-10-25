import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '@agentmux/core'
import * as connectors from '@agentmux/connectors'
import { fileUploadRevision } from '@agentmux/core/files'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { feishuConfig, feishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuMediaPlatform } from '../../../packages/connectors/test/fixtures/feishu-media-platform.js'
import { discordConfig, discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'
import { startAgentMuxHost } from '../src/host.js'
const privateHome = vi.hoisted(() => ({ directory: undefined as string | undefined }))
vi.mock('node:os', async load => { const original = await load<typeof import('node:os')>(); return { ...original, homedir: () => privateHome.directory ?? original.homedir() } })
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
const png = process.env.AGENTMUX_TEST_IMAGE_VISUAL === '1' ? readFileSync(new URL('../../desktop/resources/settings-banner.png', import.meta.url)) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
async function fixture() {
  const original = await rpcOwnerFixture(['image-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'image-native', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(original.close)
  privateHome.directory = original.root
  await writeFile(join(original.root, 'native.jsonl'), JSON.stringify({ type: 'user', sessionId: 'image-native', uuid: 'before-binding', message: { role: 'user', content: 'Earlier private input' } }) + '\n')
  await original.client.dispose(); feishuSdkTransport()
  const feishu = await feishuMediaPlatform(), discord = await discordTransport(); cleanup.push(feishu.close, discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const factory = connectors.createConnectionServices, opened: connectors.ConnectionServices[] = []
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => { const service = await factory(options); opened.push(service); return service })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const socketPath = join(original.root, 'image-publication.sock')
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function () {
      const inner = this as unknown as typeof original.inner; await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => false
    })
    try { host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory: join(original.root, 'connections') } }) }
    finally { connect.mockRestore() }
  }
  const stop = async () => { const current = host; host = undefined; await current?.dispose() }; cleanup.push(stop)
  await start(); let rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => rpc.dispose())
  const owner = (await rpc.call('runtime.owner.identity', {})).owner
  for (const config of [feishuConfig, discordConfig]) {
    const secret = await rpc.call('connection.credential.store', { operationId: config.adapterId + '-secret', secret: 'synthetic-original-image-credential' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
    await rpc.call('connection.configure', { operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
    expect(await rpc.call('connection.bind', { operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding', connectionId: config.connectionId, expectedConnectionRevision: 1,
      executionHostId: 'local', agentSessionId: 'image-agent', externalConversationId: config.adapterId === 'discord' ? '300' : 'original-room', expectedSource: { providerId: 'claude', nativeSessionId: 'image-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })).toMatchObject({ state: 'applied' })
  }
  const upload = (id: string) => ({ hostId: 'local', agentSessionId: 'image-agent', expectedRun: { runId: 'run-image-agent' }, operationId: id, name: 'image', mimeType: 'image/png', byteLength: png.length, revision: fileUploadRevision(png) })
  const source = join(original.root, '.agentmux', 'pasted', 'a'.repeat(64) + '.png')
  const send = async (prompt: string, inputImages?: core.AgentInputImageReference[], operationId = 'original-selected-input') => {
    await host!.client.submitAgentPrompt({ agentSessionId: 'image-agent', expectedRun: { runId: 'run-image-agent' }, operationId, prompt, ...(inputImages ? { inputImages } : {}), authorHuman: true, sourceChannel: 'message-tool', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
    opened.at(-1)!.publication!.refresh()
  }
  const operations = () => ['feishu-binding', 'discord-binding'].flatMap(bindingId => opened.at(-1)!.publication!.store.list({ bindingId, revision: 1 })).filter(operation => operation.payload.kind !== 'binding-lifecycle')
  return { socketPath, original, feishu, discord, upload, source, send, get rpc() { return rpc }, operations, services: () => opened.at(-1)!, conversation: () => host!.client.readAgentConversation({ hostId: 'local', agentSessionId: 'image-agent' }), async restart() { await rpc.dispose(); await stop(); await start(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }) } }
}
it.each(['selected', 'legacy', 'missing', 'changed'] as const)('default Host projects %s user images through both official SDKs without local references', async mode => {
  const f = await fixture(), path = '@' + f.source, prompt = 'Before original picture ' + path + ' After original picture', upload = f.upload('original-paste')
  let inputImages: core.AgentInputImageReference[] | undefined
  if (mode !== 'legacy') {
    inputImages = [{ start: prompt.indexOf(path), end: prompt.indexOf(path) + path.length, bodyRevision: fileUploadRevision(new TextEncoder().encode(prompt)), upload }]
    if (mode !== 'missing') {
      const receipt = await f.rpc.call('file.upload', { ...upload, dataBase64: png.toString('base64') })
      expect(receipt.status).toBe('uploaded')
      if (mode === 'changed' && receipt.status === 'uploaded') await writeFile(receipt.path, Buffer.alloc(png.length))
    }
  }
  await f.send(prompt, inputImages)
  await vi.waitFor(() => {
    for (const wire of [JSON.stringify(f.feishu.calls), JSON.stringify(f.discord.calls)]) { expect(wire).toContain('Before original picture'); expect(wire).toContain('After original picture'); expect(wire).not.toContain(f.source); expect(wire).not.toContain('.agentmux/pasted') }
    if (mode === 'selected') { expect(f.feishu.uploads.map(fileUploadRevision)).toEqual([fileUploadRevision(png)]); expect(f.discord.uploads.map(fileUploadRevision)).toEqual([fileUploadRevision(png)]) }
    else { expect(JSON.stringify(f.feishu.calls)).toContain('[Image not shared]'); expect(JSON.stringify(f.discord.calls)).toContain('[Image not shared]'); expect(f.feishu.uploads).toEqual([]); expect(f.discord.uploads).toEqual([]) }
  }, { timeout: 30000 })
  const before = f.operations(); expect(before.length).toBeGreaterThan(0)
  const images = before.filter(operation => operation.payload.kind === 'image')
  if (mode === 'selected') expect(images).toHaveLength(2)
  if (process.env.AGENTMUX_TEST_IMAGE_OUTPUT && ['selected', 'missing'].includes(mode)) await writeFile(join(process.env.AGENTMUX_TEST_IMAGE_OUTPUT, mode + '-image-wire.json'), JSON.stringify({ feishu: f.feishu.calls, discord: f.discord.calls }, null, 2))
  expect(originalText(await f.conversation())).toContain(f.source)
}, 60000)
function originalText(value: unknown) { return JSON.stringify(value) }

it('keeps multiple selected images in order and retains original delivery identities after the default Host reopens', async () => {
  const f = await fixture(), first = '@' + f.source, second = '@' + f.source.replace('a'.repeat(64), 'b'.repeat(64))
  const prompt = 'First ' + first + ' Middle ' + second + ' Last'
  const inputImages: core.AgentInputImageReference[] = []
  for (const [index, path] of [first, second].entries()) {
    const upload = f.upload('selected-image-' + index)
    expect(await f.rpc.call('file.upload', { ...upload, dataBase64: png.toString('base64') })).toMatchObject({ status: 'uploaded' })
    inputImages.push({ start: prompt.indexOf(path), end: prompt.indexOf(path) + path.length, bodyRevision: fileUploadRevision(new TextEncoder().encode(prompt)), upload })
  }
  await f.send(prompt, inputImages)
  await vi.waitFor(() => { expect(f.feishu.uploads).toEqual([png, png]); expect(f.discord.uploads).toEqual([png, png]); expect(f.operations().filter(op => op.payload.kind === 'image')).toHaveLength(4); expect(f.operations().every(op => op.state === 'confirmed')).toBe(true) }, { timeout: 30000 })
  for (const bindingId of ['feishu-binding', 'discord-binding']) {
    const operations = f.operations().filter(op => op.bindingId === bindingId)
    expect(operations.map(op => op.payload.kind)).toEqual(['speech', 'image', 'speech', 'image', 'speech'])
    expect(operations.filter(op => op.payload.kind === 'speech').map(op => op.payload.text)).toEqual(['First ', ' Middle ', ' Last'])
  }
  const original = f.operations().map(op => ({ id: op.operationId, payload: op.payload, prepared: op.prepared, uploads: op.uploads, attempt: op.attempt }))
  await f.restart(); await f.send('Fresh input after reopening', undefined, 'after-reopening')
  await vi.waitFor(() => { expect(JSON.stringify(f.feishu.calls)).toContain('Fresh input after reopening'); expect(JSON.stringify(f.discord.calls)).toContain('Fresh input after reopening') }, { timeout: 30000 })
  await vi.waitFor(() => expect(f.operations().filter(op => op.payload.kind === 'speech' && op.payload.inputSubmission?.observation === 'rejoin-needed').map(op => op.state)).toEqual(Array(6).fill('confirmed')), { timeout: 30000 })
  for (const op of original) { const restored = f.services().publication!.store.inspect(op.id)!; expect({ id: restored.operationId, payload: restored.payload, prepared: restored.prepared, uploads: restored.uploads, attempt: restored.attempt }).toEqual(op) }
  expect(f.feishu.uploads).toEqual([png, png]); expect(f.discord.uploads).toEqual([png, png])
  expect(JSON.stringify(f.feishu.calls) + JSON.stringify(f.discord.calls)).not.toContain('.agentmux/pasted')
}, 60000)
it.each(['upload', 'effect'] as const)('keeps an unknown %s on the same original image operation without replay on reopen', async mode => {
  const f = await fixture(), upload = f.upload('unknown-original'), path = '@' + f.source, prompt = 'Before ' + path + ' Independent text after image'
  if (mode === 'upload') f.feishu.controls.missingUploadKey = true
  else f.feishu.controls.unknownImageMessage = true
  await f.rpc.call('file.upload', { ...upload, dataBase64: png.toString('base64') })
  await f.send(prompt, [{ start: prompt.indexOf(path), end: prompt.indexOf(path) + path.length, bodyRevision: fileUploadRevision(new TextEncoder().encode(prompt)), upload }])
  const image = () => f.operations().find(op => op.bindingId === 'feishu-binding' && op.payload.kind === 'image')
  await vi.waitFor(() => { expect(image()?.state).toBe(mode === 'upload' ? 'not-applied' : 'unknown'); expect(JSON.stringify(f.feishu.calls)).toContain(mode === 'upload' ? 'Independent text after image' : 'Before'); expect(f.discord.uploads).toHaveLength(1) }, { timeout: 30000 })
  const original = image()!
  expect(await f.rpc.call('connection.delivery.inspect', { operationId: original.operationId })).toMatchObject({ delivery: { state: mode === 'upload' ? 'not-applied' : 'unknown', resourceUpload: { state: mode === 'upload' ? 'unknown' : 'confirmed', attempt: 1 } } })
  const cli = await runCompiledObjectCli(['--endpoint', 'unix:' + f.socketPath, 'connection', 'delivery', 'inspect', '--operation-id', original.operationId], objectCliEnvironment(f.original.root))
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result).toEqual(await f.rpc.call('connection.delivery.inspect', { operationId: original.operationId }))
  await f.restart(); await f.send('Independent input beyond original unknown effect', undefined, 'after-unknown')
  await vi.waitFor(() => { expect(JSON.stringify(f.feishu.calls)).toContain('Independent input beyond original unknown effect'); expect(JSON.stringify(f.discord.calls)).toContain('Independent input beyond original unknown effect') }, { timeout: 30000 })
  await vi.waitFor(() => expect(f.operations().filter(op => op.bindingId === 'discord-binding' && op.payload.kind === 'speech' && op.payload.inputSubmission?.observation === 'rejoin-needed').map(op => op.state)).toEqual(['confirmed', 'confirmed']), { timeout: 30000 })
  const restored = f.services().publication!.store.inspect(original.operationId)!
  expect(restored.payload).toEqual(original.payload); expect(restored.prepared).toEqual(original.prepared); expect(restored.uploads).toEqual(original.uploads); expect(restored.attempt).toBe(original.attempt)
  if (process.env.AGENTMUX_TEST_IMAGE_OUTPUT) await writeFile(join(process.env.AGENTMUX_TEST_IMAGE_OUTPUT, mode + '-reopen.json'), JSON.stringify({ original, operations: f.operations(), feishu: f.feishu.calls, discord: f.discord.calls, feishuUploads: f.feishu.uploads.length, discordUploads: f.discord.uploads.length }, null, 2))
  expect(f.feishu.uploads.map(fileUploadRevision)).toEqual([fileUploadRevision(png)]); expect(f.discord.uploads.map(fileUploadRevision)).toEqual([fileUploadRevision(png)])
  expect(f.feishu.calls.filter(call => call.method === 'POST' && JSON.stringify(call.body).includes('img_key'))).toHaveLength(mode === 'upload' ? 0 : 1)
}, 60000)

it('publishes changed bytes on the same native image record while retaining its original image operation', async () => {
  const f = await fixture(), changed = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII=', 'base64')
  const append = async (bytes: Buffer) => {
    await appendFile(join(f.original.root, 'native.jsonl'), JSON.stringify({ sessionId: 'image-native', uuid: 'original-native-image', type: 'assistant', message: { role: 'assistant', content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') } }
    ] } }) + '\n')
    f.services().publication!.refresh()
  }
  await append(png)
  await vi.waitFor(() => expect(f.operations().filter(op => op.payload.kind === 'image').map(op => op.state)).toEqual(['confirmed', 'confirmed']), { timeout: 30000 })
  const original = f.operations().filter(op => op.payload.kind === 'image')
  await append(changed)
  await vi.waitFor(() => {
    expect(f.feishu.uploads.map(fileUploadRevision)).toEqual([fileUploadRevision(png), fileUploadRevision(changed)])
    expect(f.discord.uploads.map(fileUploadRevision)).toEqual([fileUploadRevision(png), fileUploadRevision(changed)])
    expect(f.operations().filter(op => op.payload.kind === 'image').map(op => op.state)).toEqual(Array(4).fill('confirmed'))
  }, { timeout: 30000 })
  for (const op of original) expect(f.services().publication!.store.inspect(op.operationId)).toEqual(op)
}, 60000)

it('retains native assistant Markdown image resolution through the original resource owner', async () => {
  const f = await fixture(), text = 'Before native image\n\n![Original diagram](data:image/png;base64,' + png.toString('base64') + ')\n\nAfter native image'
  await appendFile(join(f.original.root, 'native.jsonl'), JSON.stringify({ sessionId: 'image-native', uuid: 'original-markdown-image', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }) + '\n')
  f.services().publication!.refresh()
  await vi.waitFor(() => {
    for (const uploads of [f.feishu.uploads, f.discord.uploads]) expect(uploads.map(fileUploadRevision)).toEqual([fileUploadRevision(png)])
    expect(f.operations().map(op => op.state)).toEqual(Array(6).fill('confirmed'))
  }, { timeout: 30000 })
  for (const bindingId of ['feishu-binding', 'discord-binding']) expect(f.operations().filter(op => op.bindingId === bindingId).map(op => op.payload.kind)).toEqual(['speech', 'image', 'speech'])
  for (const wire of [JSON.stringify(f.feishu.calls), JSON.stringify(f.discord.calls)]) { expect(wire).toContain('Before native image'); expect(wire).toContain('After native image') }
}, 60000)
