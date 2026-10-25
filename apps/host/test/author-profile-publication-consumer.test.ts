import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { DefaultRestOptions } from '@discordjs/rest'
import * as core from '@agentmux/core'
import * as connectors from '@agentmux/connectors'
import { objectCliEnvironment, runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
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
async function fixture(hangPortraitRead = false) {
  let portraitReadCount = 0
  const original = await rpcOwnerFixture(['profile-agent'], core, root => ({ providerId: 'claude', executorId: 'claude', nativeHandle: { kind: 'provider', providerId: 'claude', sessionId: 'profile-native', transcriptPath: join(root, 'native.jsonl') } })); cleanup.push(original.close)
  privateHome.directory = original.root
  await writeFile(join(original.root, 'native.jsonl'), JSON.stringify({ type: 'user', sessionId: 'profile-native', uuid: 'before-binding', message: { role: 'user', content: 'Earlier private input' } }) + '\n')
  await original.client.dispose(); feishuSdkTransport()
  const feishu = await feishuMediaPlatform(), discord = await discordTransport(); cleanup.push(feishu.close, discord.close)
  vi.spyOn(DefaultRestOptions, 'makeRequest').mockImplementation(discord.http.makeRequest)
  const factory = connectors.createConnectionServices, opened: connectors.ConnectionServices[] = []
  vi.spyOn(connectors, 'createConnectionServices').mockImplementation(async options => {
    if (hangPortraitRead && options.publication?.inputResource) {
      const read = options.publication.inputResource.bind(options.publication)
      options.publication.inputResource = (reference, input, signal) => {
        if (input.purpose !== 'author-avatar') return read(reference, input, signal)
        portraitReadCount++
        return new Promise((_done, reject) => { signal.addEventListener('abort', () => reject(signal.reason), {once:true}); if(signal.aborted)reject(signal.reason) })
      }
    }
    const service = await factory(options); opened.push(service); return service
  })
  let host: Awaited<ReturnType<typeof startAgentMuxHost>> | undefined
  const socketPath = join(original.root, 'profile-publication.sock')
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
    const secret = await rpc.call('connection.credential.store', { operationId: config.adapterId + '-secret', secret: 'synthetic-original-profile-credential' }, { runtimeFence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
    await rpc.call('connection.configure', { operationId: config.adapterId + '-configure', expectedRevision: null, connection: { ...config, credentialRef: secret.credentialRef } })
    expect(await rpc.call('connection.bind', { operationId: config.adapterId + '-bind', bindingId: config.adapterId + '-binding', connectionId: config.connectionId, expectedConnectionRevision: 1,
      executionHostId: 'local', agentSessionId: 'profile-agent', externalConversationId: config.adapterId === 'discord' ? '300' : 'original-room', expectedSource: { providerId: 'claude', nativeSessionId: 'profile-native' }, scope: { input: 'mentions-and-replies', publication: 'future-shared-conversation' } })).toMatchObject({ state: 'applied' })
  }
  const send = async (prompt: string, authorProfile: core.AgentPreparedAuthorProfile | undefined = profile, operationId = 'original-selected-input') => {
    await host!.client.submitAgentPrompt({ agentSessionId: 'profile-agent', expectedRun: { runId: 'run-profile-agent' }, operationId, prompt, ...(authorProfile ? {authorProfile} : {}), authorHuman: true, sourceChannel: 'message-tool', admissionIntent: { kind: 'manual-actor' }, execution: 'immediate' })
    opened.at(-1)!.publication!.refresh()
  }
  const operations = () => ['feishu-binding', 'discord-binding'].flatMap(bindingId => opened.at(-1)!.publication!.store.list({ bindingId, revision: 1 })).filter(operation => operation.payload.kind !== 'binding-lifecycle')
  return { portraitReadCount: () => portraitReadCount, socketPath, client: () => host!.client, original, feishu, discord, send, get rpc() { return rpc }, operations, services: () => opened.at(-1)!, async restart() { await rpc.dispose(); await stop(); await start(); rpc = await core.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } }) } }
}

const speechWire = (f: Awaited<ReturnType<typeof fixture>>, text: string) => f.feishu.calls.filter(call => ['POST','PATCH'].includes(call.method) && JSON.stringify(call.body).includes(text))
it('default headless Host projects the original public profile through both SDKs and the first Feishu wire uses one cached portrait', async () => {
  const f = await fixture()
  await f.send('First public profile body')
  await vi.waitFor(() => { expect(speechWire(f,'First public profile body')).not.toHaveLength(0); expect(JSON.stringify(speechWire(f,'First public profile body'))).toContain('original-image-key-1') }, {timeout:30000})
  expect(JSON.stringify(speechWire(f,'First public profile body'))).toContain('Original public person')
  expect(f.feishu.uploads).toEqual([png])
  if(process.env.AGENTMUX_TEST_PROFILE_OUTPUT){
    const original=speechWire(f,'First public profile body').find(call=>call.method==='POST')!
    await writeFile(join(process.env.AGENTMUX_TEST_PROFILE_OUTPUT,'first-wire.json'),JSON.stringify(original,null,2)+'\n')
    await writeFile(join(process.env.AGENTMUX_TEST_PROFILE_OUTPUT,'first-card.json'),JSON.stringify(JSON.parse((original.body as {content:string}).content),null,2)+'\n')
    await writeFile(join(process.env.AGENTMUX_TEST_PROFILE_OUTPUT,'avatar.png'),png)
  }
  await vi.waitFor(() => expect(JSON.stringify(f.discord.calls)).toContain('Original public person'), {timeout:30000})
  const original = f.operations().filter(op => op.payload.kind === 'speech' && op.payload.text === 'First public profile body')
  await f.send('Second cached portrait body', profile, 'second-profile')
  await vi.waitFor(() => expect(JSON.stringify(speechWire(f,'Second cached portrait body'))).toContain('original-image-key-1'), {timeout:30000})
  expect(f.feishu.uploads).toEqual([png])
  await f.restart(); await f.send('After original Host reopened', profile, 'third-profile')
  await vi.waitFor(() => expect(JSON.stringify(speechWire(f,'After original Host reopened'))).toContain('original-image-key-1'), {timeout:30000})
  expect(f.feishu.uploads).toEqual([png])
  for (const op of original) { const restored = f.services().publication!.store.inspect(op.operationId)!; expect(restored.prepared).toEqual(op.prepared); expect(restored.attempt).toBe(op.attempt) }
  const input = { key: {kind:'prompt' as const,agentSessionId:'profile-agent',expectedRun:{runId:'run-profile-agent'},submissionId:'original-selected-input'}, purpose:'author-avatar' as const,index:0,revision:profile.avatar!.revision,maxBytes:144*1024 }
  expect(await f.rpc.call('agent.input.resource',input)).toMatchObject({status:'available',dataBase64:png.toString('base64')})
  const cli = await runCompiledObjectCli(['--endpoint','unix:'+f.socketPath,'agent','input','resource','--input','-'], objectCliEnvironment(f.original.root),JSON.stringify(input))
  expect(cli.code,cli.stderr).toBe(0); expect(JSON.parse(cli.stdout).result).toMatchObject({status:'available',purpose:'author-avatar'})
},60000)
it('unknown optional portrait uploads preserve the original wire and converge only on a later real presentation demand',async()=>{
  const f=await fixture(); f.feishu.controls.missingUploadKey=true
  await f.send('Body while portrait is unknown')
  await vi.waitFor(()=>expect(speechWire(f,'Body while portrait is unknown')).not.toHaveLength(0),{timeout:30000})
  const original=f.operations().find(op=>op.bindingId==='feishu-binding'&&op.payload.kind==='speech'&&op.payload.text==='Body while portrait is unknown')!
  expect(original.avatarUploads?.at(-1)?.state).toBe('unknown');expect(f.feishu.uploads).toEqual([png])
  f.feishu.controls.missingUploadKey=false
  await f.send('New demand after unknown portrait',profile,'later-profile')
  await vi.waitFor(()=>expect(JSON.stringify(speechWire(f,'New demand after unknown portrait'))).toContain('original-image-key-2'),{timeout:30000})
  expect(f.feishu.uploads).toEqual([png,png]);const restored=f.services().publication!.store.inspect(original.operationId)!
  expect(restored.prepared).toEqual(original.prepared);expect(restored.avatarUploads).toEqual(original.avatarUploads);expect(restored.attempt).toBe(original.attempt)
},60000)
it('bounded portrait preparation keeps body and input available while simultaneous demand shares one upload',async()=>{
  const f=await fixture(); let release!:()=>void;const held=new Promise<void>(done=>{release=done});cleanup.push(release)
  f.feishu.controls.beforeUpload=()=>held
  await Promise.all([f.send('Portrait deadline first body',profile,'deadline-first'),f.send('Portrait deadline second body',profile,'deadline-second')])
  await vi.waitFor(()=>{expect(speechWire(f,'Portrait deadline first body')).not.toHaveLength(0);expect(speechWire(f,'Portrait deadline second body')).not.toHaveLength(0)},{timeout:30000})
  expect(f.feishu.uploads).toEqual([png]);expect(JSON.stringify(speechWire(f,'Portrait deadline first body'))).not.toContain('img_key')
  expect((await f.client().sessionTimeline('profile-agent')).items.filter(item=>item.content?.startsWith('Portrait deadline'))).toHaveLength(2)
  const originals=f.operations().filter(op=>op.bindingId==='feishu-binding'&&op.payload.kind==='speech'&&op.payload.text.startsWith('Portrait deadline')).map(op=>({id:op.operationId,prepared:op.prepared}))
  release();await vi.waitFor(()=>expect(f.services().publication!.store.inspect(originals[0]!.id)?.avatarUploads?.at(-1)?.state).toBe('confirmed'),{timeout:30000})
  await f.send('Later demand with settled portrait',profile,'settled-profile')
  await vi.waitFor(()=>expect(JSON.stringify(speechWire(f,'Later demand with settled portrait'))).toContain('original-image-key-1'),{timeout:30000})
  expect(f.feishu.uploads).toEqual([png]);for(const op of originals)expect(f.services().publication!.store.inspect(op.id)?.prepared).toEqual(op.prepared)
},60000)

it('a hanging optional original portrait read remains bounded and shared while both native channel bodies continue',async()=>{
 const f=await fixture(true);await f.send('Body beyond an unavailable portrait read')
 await vi.waitFor(()=>{expect(speechWire(f,'Body beyond an unavailable portrait read')).not.toHaveLength(0);expect(JSON.stringify(f.discord.calls)).toContain('Body beyond an unavailable portrait read')},{timeout:30000})
 expect(f.portraitReadCount()).toBe(1)
 for(let i=0;i<3;i++)f.services().publication!.refresh()
 expect((await f.client().sessionTimeline('profile-agent')).items.some(item=>item.content==='Body beyond an unavailable portrait read')).toBe(true)
 expect(f.portraitReadCount()).toBe(1);expect(f.feishu.uploads).toEqual([])
 expect(JSON.stringify(speechWire(f,'Body beyond an unavailable portrait read'))).toContain('Original public person')
},60000)

it.each(['connection','application','image'] as const)('scopes portrait receipts to the exact %s namespace through the default Host',async kind=>{
 const f=await fixture();await f.send('Original portrait namespace body')
 await vi.waitFor(()=>expect(JSON.stringify(speechWire(f,'Original portrait namespace body'))).toContain('original-image-key-1'),{timeout:30000})
 let selected=profile, bindingId='feishu-binding'
 if(kind==='image'){
  selected=preparePublicUserProfile({displayName:'Original public person',avatar:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a0K8AAAAASUVORK5CYII='})!
 }else{
  bindingId=kind+'-isolated-binding'
  const owner=(await f.rpc.call('runtime.owner.identity',{})).owner
  const secret=await f.rpc.call('connection.credential.store',{operationId:'isolated-credential',secret:'synthetic-isolated-profile-credential'},{runtimeFence:{runtimeId:owner.runtimeId,ownerInstanceId:owner.ownerInstanceId}})
  const connection={...feishuConfig,connectionId:kind+'-isolated-connection',credentialRef:secret.credentialRef,
   application:kind==='application'?{...feishuConfig.application,appId:'cli_fedcba9876543210'}:feishuConfig.application}
  if(kind==='application')await expect(f.rpc.call('connection.configure',{operationId:'forbidden-application-reassignment',expectedRevision:1,connection:{...connection,connectionId:feishuConfig.connectionId}})).rejects.toMatchObject({code:'CONNECTION_IDENTITY_CONFLICT'})
  await f.rpc.call('connection.configure',{operationId:'isolate-connection',expectedRevision:null,connection})
  expect(await f.rpc.call('connection.bind',{operationId:'isolate-binding',bindingId,connectionId:connection.connectionId,expectedConnectionRevision:1,
   executionHostId:'local',agentSessionId:'profile-agent',externalConversationId:'isolated-room',expectedSource:{providerId:'claude',nativeSessionId:'profile-native'},scope:{input:'mentions-and-replies',publication:'future-shared-conversation'}})).toMatchObject({state:'applied'})
 }
 await f.send('Exact portrait namespace body',selected,'namespace-input')
 await vi.waitFor(()=>expect(f.feishu.uploads).toHaveLength(2),{timeout:30000})
 const bytes=Buffer.from(selected.avatar!.dataBase64,'base64');expect(f.feishu.uploads[1]).toEqual(bytes)
 await vi.waitFor(()=>{
  const operation=f.services().publication!.store.list({bindingId,revision:1}).find(op=>op.payload.kind==='speech'&&op.payload.text==='Exact portrait namespace body')!
  expect(operation.avatarUploads?.at(-1)).toEqual({state:'confirmed',imageKey:'original-image-key-2'})
  expect(operation.avatarSource).toBeUndefined()
 },{timeout:30000})
 // This platform fixture has one fixed message sender. A second application therefore
 // keeps its independently unknown message receipt; only the exact media receipt is asserted.
},60000)
