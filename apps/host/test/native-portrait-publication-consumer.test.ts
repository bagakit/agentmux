import { readFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '@agentmux/core'
import * as connectors from '@agentmux/connectors'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
import { savedQuestionEvent, savedQuestionJsonl } from '../../../packages/core/test/helpers/codex-saved-question.js'
import type { PublicationOperation } from '../../../packages/connectors/src/publication-store.js'
import type { ConnectionDelivery } from '../../../packages/core/src/connection-delivery-contract.js'
import { FEISHU_MESSAGE_BODY_BYTES } from '../../../packages/connectors/src/adapters/feishu/message.js'
import { rpcOwnerFixture } from '../../../packages/core/test/helpers/public-rpc-owner.js'
import { feishuConfig, feishuSdkTransport } from '../../../packages/connectors/test/fixtures/feishu.js'
import { feishuMediaPlatform } from '../../../packages/connectors/test/fixtures/feishu-media-platform.js'
import { discordConfig, discordTransport } from '../../../packages/connectors/test/fixtures/discord.js'
import { startAgentMuxHost } from '../src/host.js'
import { preparePublicUserProfile } from '../src/public-author-profile.js'
const privateHome = vi.hoisted(() => ({ directory: undefined as string | undefined }))
vi.mock('node:os', async load => { const original = await load<typeof import('node:os')>(); return { ...original, homedir: () => privateHome.directory ?? original.homedir() } })
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { try { for (const close of cleanup.splice(0).reverse()) await close() } finally { vi.restoreAllMocks(); vi.unstubAllEnvs() } })
const png = process.env.AGENTMUX_TEST_PROFILE_VISUAL_PNG ? readFileSync(process.env.AGENTMUX_TEST_PROFILE_VISUAL_PNG) : Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
const profile = preparePublicUserProfile({displayName: 'Original public person', avatar: 'data:image/png;base64,' + png.toString('base64')})!
async function fixture(portraitRead: boolean | { wait?: () => Promise<void>; unavailable?: true } = false, providerId: 'claude' | 'codex' = 'claude') {
  let portraitReadCount = 0
  const original = await rpcOwnerFixture(['profile-agent'], core, root => ({ providerId, executorId: providerId, nativeHandle: { kind: 'provider', providerId, sessionId: 'profile-native', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(original.close)
  privateHome.directory = original.root
  const configurationPath = join(original.root, 'app-config.json')
  await writeFile(configurationPath, JSON.stringify({ appearance: {}, executors: { [providerId]: { providerId } }, workspaces: [] }))
  await writeFile(join(original.root, 'native.jsonl'), JSON.stringify(providerId === 'claude' ? { type: 'user', sessionId: 'profile-native', uuid: 'before-binding', message: { role: 'user', content: 'Earlier private input' } } : { type: 'session_meta', payload: { id: 'profile-native', cwd: original.root, source: 'cli' } }) + '\n')
  await original.client.dispose(); feishuSdkTransport()
  const feishu = await feishuMediaPlatform(), discord = await discordTransport(); cleanup.push(feishu.close, discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const factory = connectors.createConnectionServices, opened: connectors.ConnectionServices[] = []
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => {
    if (options.publication?.inputResource) {
      const read = options.publication.inputResource.bind(options.publication)
      options.publication.inputResource = async (reference, input, signal) => {
        if (input.purpose !== 'author-avatar') return read(reference, input, signal)
        portraitReadCount++
        if (portraitRead === true || typeof portraitRead === 'object' && portraitRead.wait) {
          const abort = new Promise<never>((_done, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason) })
          if (portraitRead === true) return abort
          await Promise.race([portraitRead.wait!(), abort])
        }
        if (typeof portraitRead === 'object' && portraitRead.unavailable) return { key: input.key, purpose: input.purpose, index: input.index, revision: input.revision, status: 'unavailable', code: 'INPUT_AUTHOR_AVATAR_UNAVAILABLE', message: 'The original optional resource is unavailable.' }
        return read(reference, input, signal)
      }
    }
    const service = await factory(options); opened.push(service); return service
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const socketPath = join(original.root, 'profile-publication.sock')
  const start = async () => {
    const connect = vi.spyOn(core.AgentMuxClient.prototype, 'connect').mockImplementationOnce(async function (this: core.AgentMuxClient) {
      const inner = this as unknown as typeof original.inner; await inner.registry.load('local'); inner.connected = true; inner.kernel.isConnected = () => false
    })
    try { host = await startAgentMuxHost({ store: original.store, socketPath, desktopSocketPath: join(original.root, 'absent-desktop.sock'), mobileBuildDirectory: join(original.root, 'absent-mobile'), connections: { directory: join(original.root, 'connections'), moteConfigurationPath: configurationPath } }) }
    finally { connect.mockRestore() }
  }
  const stop = async () => { const current = host; host = undefined; await current?.dispose() }; cleanup.push(stop)
  await start(); let rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }); cleanup.push(() => rpc.dispose())
  const owner = (await rpc.call('runtime.owner.identity', {})).owner
  for (const config of [feishuConfig, discordConfig]) {
    const secret = await rpc.call('connection.credential.store', { operationId: config.adapterId + '-secret', secret: 'synthetic-original-profile-credential' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
    await rpc.call('connection.configure', { operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
    expect(await rpc.call('connection.bind', { operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding', connectionId: config.connectionId, expectedConnectionRevision: 1,
      executionHostId: 'local', agentSessionId: 'profile-agent', externalConversationId: config.adapterId === 'discord' ? '300' : 'original-room', expectedSource: { providerId, nativeSessionId: 'profile-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })).toMatchObject({ state: 'applied' })
  }
  const send = async (prompt: string, authorProfile: core.AgentPreparedAuthorProfile | undefined = profile, operationId = 'original-selected-input') => {
    await host!.client.submitAgentPrompt({ agentSessionId: 'profile-agent', expectedRun: { runId: 'run-profile-agent' }, operationId, prompt, ...(authorProfile ? {authorProfile} : {}), authorHuman: true, sourceChannel: 'message-tool', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
    opened.at(-1)!.publication!.refresh()
  }
  const operations = () => ['feishu-binding', 'discord-binding'].flatMap(bindingId => opened.at(-1)!.publication!.store.list({ bindingId, revision: 1 })).filter(operation => operation.payload.kind !== 'binding-lifecycle')
  const append = (content: unknown[], uuid = 'changing-native-reply') => { appendFileSync(join(original.root, 'native.jsonl'), JSON.stringify({ sessionId: 'profile-native', uuid, type: 'assistant', message: { role: 'assistant', content } }) + '\n'); opened.at(-1)!.publication!.refresh() }
  const drained = async () => { const lanes = (opened.at(-1)!.publication as unknown as { lanes: Map<string, {work?: Promise<void>}> }).lanes; for (const lane of lanes.values()) if (lane.work) await lane.work }
  const optionalDrained = async () => { await drained(); const pending = (opened.at(-1)!.publication as unknown as { resourcePreparations: Map<string, Promise<unknown>> }).resourcePreparations; await Promise.all([...pending.values()]) }
  return { append, drained, optionalDrained, portraitReadCount: () => portraitReadCount, socketPath, client: () => host!.client, original, feishu, discord, send, get rpc() { return rpc }, operations, services: () => opened.at(-1)!, async restart() { await rpc.dispose(); await stop(); await start(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }) } }
}

function hold() { let release!: () => void; const promise = new Promise<void>(done => { release = done }); cleanup.push(release); return { promise, release } }
const bodyOf = (f: Awaited<ReturnType<typeof fixture>>, id: string) => JSON.parse(String((f.feishu.messages.get(id)?.body as { content: string })?.content))
const nativeCalls = (f: Awaited<ReturnType<typeof fixture>>) => f.feishu.calls.filter(call => call.path.startsWith('/open-apis/cardkit/'))
const portraits = (f: Awaited<ReturnType<typeof fixture>>) => nativeCalls(f).filter(call => call.path.includes('/elements/'))
const userOperation = (f: Awaited<ReturnType<typeof fixture>>, text: string) => f.operations().find(op => op.bindingId === 'feishu-binding' && op.payload.kind === 'speech' && op.payload.text === text)

it('default Host completes the sole original user card after a delayed portrait without another message', async () => {
  const f = await fixture(), upload = hold()
  f.feishu.controls.beforeUpload = () => upload.promise
  await f.send('Only original user message')
  await f.drained()
  expect(userOperation(f, 'Only original user message')?.state).toBe('confirmed')
  const original = userOperation(f, 'Only original user message')!
  expect(original.mapping?.nativeCard).toBeDefined()
  expect(JSON.stringify(bodyOf(f, original.mapping!.messageId))).toContain('Only original user message')
  expect(JSON.stringify(bodyOf(f, original.mapping!.messageId))).not.toContain('custom_icon')
  upload.release()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(original.operationId)?.portrait?.state).toBe('confirmed'))
  expect(portraits(f)).toHaveLength(1)
  expect(JSON.stringify(bodyOf(f, original.mapping!.messageId))).toContain('original-image-key-1')
  expect(f.services().publication!.store.inspect(original.operationId)?.prepared).toEqual(original.prepared)
  const observed = await f.rpc.call('connection.delivery.inspect', { operationId: original.operationId })
  expect(observed).toMatchObject({ delivery: { state: 'confirmed', presentation: { entity: { state: 'confirmed' }, portrait: { state: 'confirmed' } }, mapping: original.mapping } })
  expect(JSON.stringify(observed)).not.toContain('original-image-key-1')
  expect(JSON.stringify(observed)).not.toContain('Only original user message')
  const afterPortrait = bodyOf(f, original.mapping!.messageId)
  await f.restart(); await f.drained()
  expect(portraits(f)).toHaveLength(1)
  expect(nativeCalls(f).filter(call => call.method === 'POST')).toHaveLength(1)
  if (process.env.NATIVE_PORTRAIT_VISUAL) await writeFile(join(process.env.NATIVE_PORTRAIT_VISUAL, 'sole-card.json'), JSON.stringify({ before: JSON.parse(String((nativeCalls(f).find(call => call.method === 'POST')!.body as { data: string }).data)), after: afterPortrait, operationId: original.operationId }, null, 2))
})

it.each(['denied', 'unknown', 'late'] as const)('default Host preserves the original body when optional create is %s', async mode => {
  const f = await fixture(), upload = hold(), create = hold()
  f.feishu.controls.beforeUpload = () => upload.promise
  if (mode === 'denied') f.feishu.controls.rejectCardCreate = true
  if (mode === 'unknown') f.feishu.controls.unknownCardCreate = true
  if (mode === 'late') f.feishu.controls.beforeCardCreate = () => create.promise
  await f.send('Healthy body after ' + mode)
  await vi.waitFor(() => expect(userOperation(f, 'Healthy body after ' + mode)?.cardPreparation).toBeDefined())
  await f.drained()
  const operation = userOperation(f, 'Healthy body after ' + mode)!
  // Observe the completed consumer cycle, then assert the business result; a timeout is not the failure oracle.
  expect(operation.state).toBe('confirmed')
  expect(operation.mapping?.nativeCard).toBeUndefined()
  expect(JSON.stringify(bodyOf(f, operation.mapping!.messageId))).toContain('Healthy body after ' + mode)
  const original = operation.prepared
  create.release(); upload.release()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(operation.operationId)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  await f.restart(); await f.drained()
  expect(f.services().publication!.store.inspect(operation.operationId)?.prepared).toEqual(original)
  expect(nativeCalls(f).filter(call => call.method === 'POST')).toHaveLength(1)
  expect(portraits(f)).toHaveLength(0)
})

it('default Host cached and absent portraits do not create optional entities', async () => {
  const f = await fixture()
  await f.send('Seed confirmed original portrait')
  await f.drained()
  expect(userOperation(f, 'Seed confirmed original portrait')?.state).toBe('confirmed')
  const count = nativeCalls(f).length
  await f.send('Cached original portrait', profile, 'cached-input')
  await f.send('No selected portrait', { name: 'Only public name' }, 'no-image-input')
  await f.drained()
  expect(userOperation(f, 'No selected portrait')?.state).toBe('confirmed')
  expect(nativeCalls(f)).toHaveLength(count)
  expect(JSON.stringify(bodyOf(f, userOperation(f, 'Cached original portrait')!.mapping!.messageId))).toContain('original-image-key-1')
  expect(userOperation(f, 'No selected portrait')?.cardPreparation).toBeUndefined()
})

it('default Host keeps the same native message through speech image and speech while an older portrait is delayed', async () => {
  const f = await fixture(), upload = hold(), decoration = hold()
  f.feishu.controls.beforeUpload = async (_bytes, index) => { if (index === 1) await upload.promise }
  f.feishu.controls.beforeCardUpdate = async (_sequence, element) => { if (element) await decoration.promise }
  f.append([{ type: 'text', text: 'Original native body' }])
  await f.drained()
  expect(userOperation(f, 'Original native body')?.state).toBe('confirmed')
  const first = userOperation(f, 'Original native body')!
  expect(first.mapping?.nativeCard).toBeDefined()
  upload.release()
  await vi.waitFor(() => expect(portraits(f)).toHaveLength(1))
  f.append([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }])
  await vi.waitFor(() => expect(f.operations().some(op => op.bindingId === 'feishu-binding' && op.payload.kind === 'image')).toBe(true))
  await f.drained()
  const image = f.operations().find(op => op.bindingId === 'feishu-binding' && op.payload.kind === 'image')!
  expect(image.state).toBe('confirmed')
  expect(image.mapping).toEqual(first.mapping)
  expect(image.projectionId).toBe(first.projectionId); expect(image.fragment.ordinal).toBe(first.fragment.ordinal)
  expect(image.predecessorOperationId).toBe(first.operationId)
  expect(f.feishu.uploads[1]).toEqual(png); expect(f.feishu.uploads[0]).not.toEqual(png)
  const picture = bodyOf(f, first.mapping!.messageId)
  expect(picture).toMatchObject({ schema: '2.0', body: { elements: [{ tag: 'img', img_key: 'original-image-key-2' }] } })
  decoration.release()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(first.operationId)?.portrait?.state).toBe('not-applied'))
  expect(bodyOf(f, first.mapping!.messageId)).toEqual(picture)
  f.append([{ type: 'text', text: 'New native body after picture' }])
  await f.drained()
  expect(userOperation(f, 'New native body after picture')?.state).toBe('confirmed')
  expect(userOperation(f, 'New native body after picture')?.mapping).toEqual(first.mapping)
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('New native body after picture')
  expect(nativeCalls(f).filter(call => call.method === 'POST')).toHaveLength(1)
  expect(f.feishu.calls.filter(call => call.path.endsWith('/' + first.mapping!.messageId) && ['PATCH', 'DELETE'].includes(call.method))).toHaveLength(0)
  await f.restart(); await f.drained()
  expect(userOperation(f, 'New native body after picture')?.mapping).toEqual(first.mapping)
  if (process.env.NATIVE_PORTRAIT_VISUAL) await writeFile(join(process.env.NATIVE_PORTRAIT_VISUAL, 'image-card.json'), JSON.stringify(picture, null, 2))
})

it('default Host gives a previously unknown body priority over a newly available portrait', async () => {
  const f = await fixture(), upload = hold(), body = hold()
  f.feishu.controls.beforeUpload = () => upload.promise
  f.append([{ type: 'text', text: 'First body before uncertainty' }])
  await f.drained()
  expect(userOperation(f, 'First body before uncertainty')?.state).toBe('confirmed')
  const first = userOperation(f, 'First body before uncertainty')!
  expect(first.mapping?.nativeCard).toBeDefined()
  f.feishu.controls.deferCardBody = body.promise
  f.append([{ type: 'text', text: 'New body accepted with a lost response' }])
  await f.drained()
  expect(userOperation(f, 'New body accepted with a lost response')?.state).toBe('unknown')
  upload.release()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(first.operationId)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  await f.optionalDrained()
  body.release(); await Promise.all(f.feishu.pendingCardBodies)
  // A stale identity cannot consume a newer sequence and invalidate the previously accepted body.
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('New body accepted with a lost response')
  expect(portraits(f)).toHaveLength(0)
})

it('default Host keeps a lost portrait receipt unknown while a newer body uses the confirmed original image', async () => {
  const f = await fixture(), upload = hold(), read = hold()
  f.feishu.controls.beforeUpload = () => upload.promise
  f.feishu.controls.unknownPortrait = true
  f.append([{ type: 'text', text: 'Original body for unknown portrait' }])
  await f.drained()
  expect(userOperation(f, 'Original body for unknown portrait')?.state).toBe('confirmed')
  const first = userOperation(f, 'Original body for unknown portrait')!
  f.feishu.controls.beforeMessageRead = () => read.promise
  upload.release()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(first.operationId)?.portrait?.state).toBe('unknown'))
  f.append([{ type: 'text', text: 'New body beyond the unknown portrait' }])
  await f.drained()
  expect(userOperation(f, 'New body beyond the unknown portrait')?.state).toBe('confirmed')
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('New body beyond the unknown portrait')
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('original-image-key-1')
  read.release(); await f.optionalDrained()
  const original = f.services().publication!.store.inspect(first.operationId)!
  await f.restart(); await f.optionalDrained()
  expect(f.services().publication!.store.inspect(first.operationId)?.portrait).toEqual(original.portrait)
  expect(portraits(f)).toHaveLength(1)
})

it('default Host preserves a direct IM mapping when a later source revision has a portrait', async () => {
  const f = await fixture(), upload = hold()
  f.feishu.controls.beforeUpload = () => upload.promise
  f.feishu.controls.rejectCardCreate = true
  f.append([{ type: 'text', text: 'Existing direct message' }])
  await f.drained()
  expect(userOperation(f, 'Existing direct message')?.state).toBe('confirmed')
  const first = userOperation(f, 'Existing direct message')!
  expect(first.mapping?.nativeCard).toBeUndefined()
  upload.release()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(first.operationId)?.avatarUploads?.at(-1)?.state).toBe('confirmed'))
  f.feishu.controls.rejectCardCreate = false
  f.append([{ type: 'text', text: 'Updated existing direct message' }])
  await f.drained()
  expect(userOperation(f, 'Updated existing direct message')?.state).toBe('confirmed')
  expect(userOperation(f, 'Updated existing direct message')?.mapping).toEqual(first.mapping)
  expect(nativeCalls(f).filter(call => call.method === 'POST')).toHaveLength(1)
  expect(portraits(f)).toHaveLength(0)
})

it.each(['image', 'pause'] as const)('default Host retires unclaimed portrait work after the original %s boundary changes', async mode => {
  const f = await fixture(), upload = hold()
  f.feishu.controls.beforeUpload = async (_bytes, index) => { if (index === 1) await upload.promise }
  f.append([{ type: 'text', text: 'Original body before boundary change' }])
  await f.drained()
  expect(userOperation(f, 'Original body before boundary change')?.state).toBe('confirmed')
  const first = userOperation(f, 'Original body before boundary change')!
  if (mode === 'image') {
    f.append([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } }])
    await vi.waitFor(() => expect(f.operations().find(op => op.bindingId === 'feishu-binding' && op.payload.kind === 'image')?.state).toBe('confirmed'))
  } else expect(await f.rpc.call('connection.binding.pause', { operationId: 'pause-original-audience', bindingId: 'feishu-binding', expectedRevision: 1 })).toMatchObject({ state: 'applied' })
  upload.release()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(first.operationId)?.avatarUploads?.at(-1)?.state).toBe(mode === 'pause' ? 'unknown' : 'confirmed'))
  await f.optionalDrained()
  expect(portraits(f)).toHaveLength(0)
  expect(f.services().publication!.store.inspect(first.operationId)?.mapping).toEqual(first.mapping)
})

it('default Host reaches ready portraits beyond sixteen unresolved originals on the same Binding', async () => {
  const f = await fixture()
  for (let index = 0; index < 17; index++) {
    const upload = hold(), text = 'Bounded portrait demand ' + index
    f.feishu.controls.beforeUpload = () => upload.promise
    f.feishu.controls.missingUploadKey = index < 16
    await f.send(text, profile, 'bounded-original-' + index)
    await f.drained()
    expect(userOperation(f, text)?.cardPreparation?.receipt.state, 'native entity for input ' + index).toBe('confirmed')
    expect(userOperation(f, text)?.state).toBe('confirmed')
    expect(userOperation(f, text)?.mapping?.nativeCard).toBeDefined()
    upload.release()
    await vi.waitFor(() => expect(f.services().publication!.store.inspect(userOperation(f, text)!.operationId)?.avatarUploads?.at(-1)?.state).toBe(index < 16 ? 'unknown' : 'confirmed'))
  }
  const last = userOperation(f, 'Bounded portrait demand 16')!
  await f.optionalDrained()
  expect(f.services().publication!.store.inspect(last.operationId)?.portrait?.state).toBe('confirmed')
  expect(JSON.stringify(bodyOf(f, last.mapping!.messageId))).toContain('original-image-key-17')
  expect(portraits(f)).toHaveLength(1)
})


it('default Host does not attribute a newer body portrait to an older readback already in flight', async () => {
  const f = await fixture(), upload = hold(), read = hold()
  f.feishu.controls.beforeUpload = () => upload.promise
  f.feishu.controls.unknownPortrait = true
  f.append([{ type: 'text', text: 'Original before in-flight readback' }])
  await f.drained()
  expect(userOperation(f, 'Original before in-flight readback')?.state).toBe('confirmed')
  const first = userOperation(f, 'Original before in-flight readback')!
  // Hold real readback before releasing the write, so a legitimate early GET cannot race the scenario.
  f.feishu.controls.beforeMessageRead = () => read.promise
  const before = f.feishu.calls.filter(call => call.method === 'GET').length
  upload.release()
  await vi.waitFor(() => expect(f.services().publication!.store.inspect(first.operationId)?.portrait?.state).toBe('unknown'))
  f.services().publication!.refresh()
  await vi.waitFor(() => expect(f.feishu.calls.filter(call => call.method === 'GET').length).toBeGreaterThan(before))
  f.append([{ type: 'text', text: 'New body while old readback is held' }])
  await f.drained()
  expect(userOperation(f, 'New body while old readback is held')?.state).toBe('confirmed')
  read.release(); await f.optionalDrained()
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('New body while old readback is held')
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('original-image-key-1')
  expect(f.services().publication!.store.inspect(first.operationId)?.portrait?.state).toBe('unknown')
  expect(portraits(f)).toHaveLength(1)
})


it('default Host exposes the original native presentation through compiled public delivery commands', async () => {
  const f = await fixture(), upload = hold()
  f.feishu.controls.beforeUpload = () => upload.promise
  await f.send('Public delivery presentation')
  await f.drained()
  expect(userOperation(f, 'Public delivery presentation')?.state).toBe('confirmed')
  const first = userOperation(f, 'Public delivery presentation')!
  if(process.env.NATIVE_PORTRAIT_CLI_PROOF) await writeFile(process.env.NATIVE_PORTRAIT_CLI_PROOF, JSON.stringify({ entry:process.env.AGENTMUX_TEST_OBJECT_CLI, sha256:(await import('node:crypto')).createHash('sha256').update(readFileSync(join(process.env.AGENTMUX_TEST_OBJECT_CLI!,'../../dist/agentmux.js'))).digest('hex') }))
  const environment = objectCliEnvironment(f.original.root)
  const observed = await f.rpc.call('connection.delivery.inspect', {operationId:first.operationId})
  const cli = await runCompiledObjectCli(['--endpoint','unix:'+f.socketPath,'connection','delivery','inspect','--operation-id',first.operationId],environment)
  expect(cli.code, cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toEqual(observed)
  const list = await runCompiledObjectCli(['--endpoint','unix:'+f.socketPath,'connection','delivery','ls','--connection','feishu-connection','--binding','feishu-binding','--binding-revision','1'],environment)
  expect(list.code,list.stderr).toBe(0)
  expect(JSON.parse(list.stdout).result.deliveries.find((row:ConnectionDelivery) => row.operationId===first.operationId)).toEqual(observed.delivery)
  upload.release()
})

it('default Host keeps body publication available when the original portrait source cannot be read', async () => {
  const f = await fixture(true)
  await f.send('Readable body with unavailable original portrait')
  await f.drained()
  const first = userOperation(f, 'Readable body with unavailable original portrait')!
  expect(first.state).toBe('confirmed'); expect(f.portraitReadCount()).toBeGreaterThan(0)
  expect(first.mapping?.nativeCard).toBeDefined(); expect(nativeCalls(f).filter(call => call.method === 'POST')).toHaveLength(1)
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('Readable body with unavailable original portrait')
})


it('default Host completes a late original avatar resource on its sole confirmed card and reuses its image', async () => {
  const source = hold(), f = await fixture({ wait: () => source.promise })
  await f.send('Late original resource')
  await f.drained()
  const first = userOperation(f, 'Late original resource')!
  expect(first.state).toBe('confirmed'); expect(first.mapping?.nativeCard).toBeDefined()
  expect(first.speaker?.avatar?.image).toBeUndefined()
  const discord = f.operations().find(op => op.bindingId === 'discord-binding' && op.payload.kind === 'speech')!
  expect(discord.state).toBe('confirmed'); expect(discord.mapping?.nativeCard).toBeUndefined()
  source.release(); await f.optionalDrained(); await f.drained(); await f.optionalDrained()
  const after = f.services().publication!.store.inspect(first.operationId)!
  expect(after.portrait?.state).toBe('confirmed')
  expect(after.avatarUploads?.at(-1)?.state).toBe('confirmed'); expect(f.feishu.uploads).toHaveLength(1)
  expect(after.prepared).toEqual(first.prepared); expect(after.receipt).toEqual(first.receipt)
  expect(after.mapping).toEqual(first.mapping); expect(after.sourceRevision).toBe(first.sourceRevision)
  expect(after.reference).toEqual(first.reference); expect(after.speaker?.avatar?.input).toEqual(first.speaker?.avatar?.input)
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('original-image-key-1')
  expect(portraits(f)).toHaveLength(1)
  expect(await f.rpc.call('connection.delivery.inspect', { operationId: first.operationId })).toMatchObject({ delivery: { state: 'confirmed', presentation: { portrait: { state: 'confirmed' } }, mapping: first.mapping } })
  const reads = f.portraitReadCount(), entities = nativeCalls(f).filter(call => call.method === 'POST').length
  await f.send('Reuse late original image', profile, 'reuse-late-image'); await f.drained()
  expect(userOperation(f, 'Reuse late original image')?.state).toBe('confirmed')
  expect(f.portraitReadCount()).toBe(reads); expect(f.feishu.uploads).toHaveLength(1)
  expect(nativeCalls(f).filter(call => call.method === 'POST')).toHaveLength(entities)
  expect(JSON.stringify(bodyOf(f, userOperation(f, 'Reuse late original image')!.mapping!.messageId))).toContain('original-image-key-1')
})

it('default Host resumes the exact pending original avatar resource after restart without resending its body', async () => {
  const source = hold(), f = await fixture({ wait: () => source.promise })
  await f.send('Original before source restart'); await f.drained()
  const first = userOperation(f, 'Original before source restart')!
  expect(first.state).toBe('confirmed'); expect(first.portrait?.state).toBe('pending')
  await f.restart(); await f.drained()
  source.release(); await f.optionalDrained(); await f.drained(); await f.optionalDrained()
  const after = f.services().publication!.store.inspect(first.operationId)!
  // Restart truthfully changes the waiting Input's observation, while the same message/entity remains.
  const current = f.operations().filter(op => op.bindingId === 'feishu-binding' && op.projectionId === first.projectionId).at(-1)!
  expect(after.portrait?.state).toBe('superseded'); expect(current.portrait?.state).toBe('confirmed')
  expect(current.speaker?.avatar?.input).toEqual(first.speaker?.avatar?.input); expect(current.mapping).toEqual(first.mapping)
  expect(after.prepared).toEqual(first.prepared); expect(after.attempt).toBe(first.attempt)
  expect(f.portraitReadCount()).toBe(2); expect(f.feishu.uploads).toHaveLength(1)
  expect(nativeCalls(f).filter(call => call.method === 'POST')).toHaveLength(1); expect(portraits(f)).toHaveLength(1)
})

it.each([true, false])('default Host shares an original avatar read across applications with first audience paused=%s', async paused => {
  const source = hold(), f = await fixture({ wait: () => source.promise })
  f.feishu.controls.applicationForRoom = { 'second-avatar-room': 'second-avatar-application' }
  const owner = (await f.rpc.call('runtime.owner.identity', {})).owner
  const secret = await f.rpc.call('connection.credential.store', { operationId: 'second-avatar-secret', secret: 'synthetic-second-application-secret' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  await f.rpc.call('connection.configure', { operationId: 'second-avatar-application', expectedRevision: null, connection: { ...feishuConfig, connectionId: 'second-avatar-connection', application: { ...feishuConfig.application, appId: 'second-avatar-application' }, credentialRef: secret.credentialRef } })
  expect(await f.rpc.call('connection.bind', { operationId: 'second-avatar-room', bindingId: 'avatar-second-binding', connectionId: 'second-avatar-connection', expectedConnectionRevision: 1,
    executionHostId: 'local', agentSessionId: 'profile-agent', externalConversationId: 'second-avatar-room', expectedSource: { providerId: 'claude', nativeSessionId: 'profile-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })).toMatchObject({ state: 'applied' })
  await f.send('Shared original resource'); await f.drained()
  const second = f.services().publication!.store.list({ bindingId: 'avatar-second-binding', revision: 1 }).find(op => op.payload.kind === 'speech')!
  expect(second.state).toBe('confirmed'); expect(second.mapping?.nativeCard).toBeDefined()
  expect(f.portraitReadCount()).toBe(1)
  if (paused) expect(await f.rpc.call('connection.binding.pause', { operationId: 'pause-first-source-reader', bindingId: 'feishu-binding', expectedRevision: 1 })).toMatchObject({ state: 'applied' })
  source.release(); await f.optionalDrained(); await f.drained(); await f.optionalDrained()
  const after = f.services().publication!.store.inspect(second.operationId)!
  expect(after.portrait?.state).toBe('confirmed'); expect(after.mapping).toEqual(second.mapping)
  expect(f.portraitReadCount()).toBe(1); expect(f.feishu.uploads).toHaveLength(paused ? 1 : 2); expect(portraits(f)).toHaveLength(paused ? 1 : 2)
  const uploaded = after.avatarUploads?.at(-1)
  expect(uploaded?.state).toBe('confirmed')
  expect(JSON.stringify(bodyOf(f, second.mapping!.messageId))).toContain(uploaded?.state === 'confirmed' ? uploaded.imageKey! : 'missing-original-image')
})

it('default Host creates no native entity for an already unavailable original avatar resource', async () => {
  const f = await fixture({ unavailable: true })
  await f.send('Known unavailable original resource'); await f.drained()
  const first = userOperation(f, 'Known unavailable original resource')!
  expect(first.state).toBe('confirmed'); expect(first.speaker?.avatar?.code).toBe('INPUT_AUTHOR_AVATAR_UNAVAILABLE')
  expect(first.mapping?.nativeCard).toBeUndefined(); expect(nativeCalls(f)).toHaveLength(0); expect(f.feishu.uploads).toHaveLength(0)
  expect(JSON.stringify(bodyOf(f, first.mapping!.messageId))).toContain('Known unavailable original resource')
})


it('default Host retains a late unavailable avatar observation without rereading it on unrelated body updates', async () => {
  const source = hold(), f = await fixture({ wait: () => source.promise, unavailable: true })
  await f.send('Late unavailable original source'); await f.drained()
  const first = userOperation(f, 'Late unavailable original source')!
  expect(first.mapping?.nativeCard).toBeDefined(); expect(first.state).toBe('confirmed')
  source.release(); await f.optionalDrained()
  expect(f.services().publication!.store.inspect(first.operationId)?.speaker?.avatar?.code).toBe('INPUT_AUTHOR_AVATAR_UNAVAILABLE')
  const reads = f.portraitReadCount()
  await f.send('Independent body after source absence', { name: 'Original person' }, 'after-source-absence'); await f.drained(); await f.optionalDrained()
  expect(userOperation(f, 'Independent body after source absence')?.state).toBe('confirmed')
  expect(f.portraitReadCount()).toBe(reads); expect(f.feishu.uploads).toHaveLength(0); expect(portraits(f)).toHaveLength(0)
  expect(f.services().publication!.store.inspect(first.operationId)?.prepared).toEqual(first.prepared)
})

it('default Host retains complete body fragments across a native entity update at the request budget', async () => {
  const f = await fixture(), upload = hold()
  f.feishu.controls.beforeUpload = () => upload.promise
  f.append([{type:'text',text:'Original native budget message'}])
  await vi.waitFor(() => expect(userOperation(f,'Original native budget message')?.state).toBe('confirmed'))
  const first = userOperation(f,'Original native budget message')!
  upload.release(); await f.optionalDrained()
  const text = '原文'.repeat(6000) + '\n\n' + 'x'.repeat(29000)
  f.append([{type:'text',text}]); await f.drained()
  const latest = f.operations().filter(op=>op.bindingId==='feishu-binding' && op.projectionId===first.projectionId && op.operationId!==first.operationId && op.payload.kind==='speech')
  expect(latest.length).toBeGreaterThan(1)
  expect(latest.every(op=>op.state==='confirmed')).toBe(true)
  expect(latest.map(op=>op.payload.kind==='speech'?op.payload.text:'').join('')).toBe(text)
  expect(latest[0]!.mapping).toEqual(first.mapping)
  for (const op of latest) expect(Buffer.byteLength(op.prepared!.request.body!)).toBeLessThanOrEqual(FEISHU_MESSAGE_BODY_BYTES)
})

async function grantQuestion(f: Awaited<ReturnType<typeof fixture>>, active = true) {
  return f.rpc.call('connection.grant', { operationId:active?'grant-question':'revoke-question', grantId:'question-person', bindingId:'feishu-binding',expectedBindingRevision:1,expectedRevision:active?null:1,
    actor:{application:feishuConfig.application,idType:'open_id',userId:'original-question-person'},capabilities:active?['answer']:[],state:active?'active':'revoked' })
}
function publishQuestion(f: Awaited<ReturnType<typeof fixture>>) {
  const event=savedQuestionEvent(); event.payload.thread_id='profile-native'
  appendFileSync(join(f.original.root,'native.jsonl'),savedQuestionJsonl([event])); f.services().publication!.refresh()
}
it('default Host preserves Question actions and state on the same original entity', async () => {
  const f=await fixture(false,'codex'),upload=hold()
  f.feishu.controls.beforeUpload=()=>upload.promise
  await grantQuestion(f); publishQuestion(f); await f.drained()
  const first=f.operations().find(op=>op.bindingId==='feishu-binding'&&op.payload.kind==='question')!
  expect(first.state).toBe('confirmed'); expect(first.payload).toMatchObject({status:'pending'}); expect(first.mapping?.nativeCard).toBeDefined()
  const before=bodyOf(f,first.mapping!.messageId)
  upload.release();await vi.waitFor(()=>expect(f.services().publication!.store.inspect(first.operationId)?.portrait?.state).toBe('confirmed'))
  expect(JSON.stringify(bodyOf(f,first.mapping!.messageId))).toContain('original-image-key-1')
  await grantQuestion(f,false); f.services().publication!.refresh();await f.drained()
  const last=f.operations().filter(op=>op.bindingId==='feishu-binding'&&op.payload.kind==='question').at(-1)!
  expect(last.state).toBe('confirmed');expect(last.payload).toMatchObject({status:'unavailable'});expect(last.mapping).toEqual(first.mapping)
  expect(bodyOf(f,first.mapping!.messageId)).not.toEqual(before)
  expect(nativeCalls(f).filter(call=>call.method==='POST')).toHaveLength(1)
})

it.each(['before-create','during-claim','after-claim'] as const)('default Host preserves independent body publication when Question authority changes %s', async mode => {
  const f=await fixture(false,'codex'),upload=hold()
  f.feishu.controls.beforeUpload=()=>upload.promise
  await grantQuestion(f)
  const permissions=Reflect.get(f.services().publication!, 'options').permissions as {authorized(operation:PublicationOperation):boolean}
  const authorized=permissions.authorized.bind(permissions)
  let allowed=mode!=='before-create'
  const denied=vi.spyOn(permissions,'authorized').mockImplementation(operation=>operation.payload.kind==='question'?allowed:authorized(operation))
  if(mode!=='before-create'){
    const store=f.services().publication!.store,claim=store.claimNext.bind(store)
    vi.spyOn(store,'claimNext').mockImplementation((...args)=>{
      const question=store.inspect(args[1])?.payload.kind==='question'
      if(question&&mode==='during-claim')allowed=false
      const result=claim(...args)
      if(question&&mode==='after-claim')allowed=false
      return result
    })
  }
  publishQuestion(f);await f.drained()
  const original=f.operations().find(op=>op.bindingId==='feishu-binding'&&op.payload.kind==='question')!
  expect(original.payload).toMatchObject({status:'pending'})
  expect(denied.mock.calls.some(([op])=>op.operationId===original.operationId)).toBe(true)
  if(mode==='before-create'){expect(nativeCalls(f)).toHaveLength(0);expect(original.cardPreparation).toBeUndefined()}
  else expect(nativeCalls(f).filter(call=>call.method==='POST')).toHaveLength(1)
  expect(original.mapping).toBeUndefined()
  upload.release();await f.optionalDrained()
  await f.send('Independent authorized ordinary body',{name:'Original person'},'independent-body');await f.drained()
  expect(userOperation(f,'Independent authorized ordinary body')?.state).toBe('confirmed')
  const read = () => f.rpc.call('connection.delivery.ls',{connectionId:'feishu-connection',bindingId:'feishu-binding',bindingRevision:1})
  expect((await read()).observation).toEqual({state:'unavailable',reason:'source-unconfirmed'})
  allowed=true; denied.mockRestore(); f.services().publication!.refresh(); await f.drained()
  expect((await read()).observation).not.toEqual({state:'unavailable',reason:'source-unconfirmed'})
})
