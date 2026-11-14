// @vitest-environment happy-dom
import { act } from 'react'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import type { MeshNetworkConfiguration, MeshNetworkSettings, MeshNetworkInspection } from '@agentmux/core/mesh-network'
import { MeshNetworkSettings as Editor } from '../src/renderer/src/components/settings/MeshNetworkSettings'
import { hostsSettingsModule } from '../src/renderer/src/components/settings/modules/hosts'
import { meshConfiguration, meshDraftForRuntime, meshForm, meshPeerCode, restoredMeshDrafts } from '../src/renderer/src/lib/mesh-settings-draft'
import { api } from '../src/renderer/src/lib/api'
import { useAppStore } from '../src/renderer/src/store'
import { composerDOM } from './helpers/composer-dom-fixture'
const dom = composerDOM()
const configuration: MeshNetworkConfiguration = { role: 'participant', networkId: 'original-network', members: [], peers: [], advertisedIngress: [], publishers: [], endpointAccess: { allowedClientKeys: [] } }
const settings: MeshNetworkSettings = { owner: { runtimeId: 'original-runtime', ownerInstanceId: 'original-process' }, identity: null, revision: 'r1', configuration, operation: null }
const observation = (value = settings): MeshNetworkInspection => ({ owner: value.owner, identity: value.identity, source: 'managed', activeRevision: value.revision, desiredRevision: value.revision, apply: { state: 'active' }, gateway: { state: 'disabled' } as never, network: null, endpoint: { state: 'not-provided' }, observedAt: 1000, coverage: { configuredOrigins: 0, observedOrigins: 0, complete: true } })
let dispose: (() => void) | undefined
beforeAll(async () => { dispose = await useAppStore.getState().initialize() })
afterAll(() => dispose?.())
beforeEach(() => { useAppStore.setState({ meshSettingsDrafts: {} }) })
async function ready() { for (let i = 0; i < 150 && !dom.container.querySelector('[aria-label="Mesh network"]'); i++) await act(async () => { await new Promise(done => setTimeout(done, 10)) }); expect(dom.container.querySelector('[aria-label="Mesh network"]'), dom.container.textContent ?? '').not.toBeNull() }
async function settled(check: () => boolean) { for (let i=0;i<200;i++) { if (check()) return; await act(async()=>{await new Promise(done=>setTimeout(done,15))}) }; throw Error('GUI did not settle: '+dom.container.textContent) }
async function input(label: string, value: string) { await act(async () => { const element = dom.container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(element.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })) }) }
function inspectOnly() { return vi.spyOn(api.mesh, 'call').mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? observation() : settings) as never) }
it('Mesh shows the App recovery action before Host answers, and reopens setup after recovery', async () => {
  let restored = false
  const read = vi.spyOn(api.ui, 'readLocalRuntimeRecovery').mockResolvedValue({ state: 'needs-backup', code: 'IDENTITY_SOURCE_MISSING' })
  const choose = vi.spyOn(api.ui, 'restoreLocalRuntimeIdentity').mockResolvedValueOnce({ state: 'needs-backup', code: 'IDENTITY_BACKUP_UNVERIFIED' })
    .mockImplementationOnce(async () => { restored = true; return { state: 'restored' } })
  const call = vi.spyOn(api.mesh, 'call').mockImplementation(async (method, _params, context) => {
    if (!restored) return await new Promise((_resolve, reject) => {
      context?.signal?.addEventListener('abort', () => reject(Error('Cancelled first read')), { once: true })
    })
    return structuredClone(method === 'mesh.inspect' ? observation() : settings) as never
  })
  try {
    await dom.render(<Editor active onConnections={vi.fn()} />)
    await settled(() => dom.container.textContent?.includes('Restore this Mac’s identity') ?? false)
    expect(dom.container.textContent).toContain('Open saved connections')
    await dom.click('[data-mesh-settings] .primary-button')
    expect(dom.container.textContent).toContain('That file couldn’t confirm this Mac’s original identity')
    await dom.click('[data-mesh-settings] .primary-button')
    await ready()
    expect(choose.mock.calls).toEqual([[], []])
    expect(call.mock.calls.filter(([method]) => method === 'settings.mesh.inspect')).toHaveLength(2)
    expect(dom.container.textContent).toContain('Connect to a gateway')
  } finally { read.mockRestore(); choose.mockRestore(); call.mockRestore() }
})
it('the original Settings section exposes Mesh and a real editor; saved connection identities keep their original route', async () => {
  inspectOnly(); expect(hostsSettingsModule.id).toBe('hosts'); expect(hostsSettingsModule.title).toBe('Mesh')
  await dom.render(<hostsSettingsModule.Pane config={useAppStore.getState().config!} active onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={{section:'hosts',field:'mesh-configuration'}} />)
  await ready(); expect(dom.container.querySelector('[data-mesh-home-view]')?.getAttribute('data-mesh-home-view')).toBe('network')
  expect(dom.container.querySelector('.mesh-editor-navigation')?.textContent).toContain('Gateway settings')
  await dom.click('.mesh-editor-navigation button')
  expect(dom.container.querySelector('[aria-current="page"]')?.textContent).toBe('Overview')
  expect(dom.container.querySelector('[aria-label="Saved devices"]')).not.toBeNull()
})
it('actual editor submits the original fence once and retains text authored after the save started', async () => {
  let finish!: (value: unknown) => void
  const call = vi.spyOn(api.mesh, 'call').mockImplementation(async method => method === 'settings.mesh.configure' ? await new Promise(done => { finish = done }) as never : structuredClone(method === 'mesh.inspect' ? observation() : settings) as never)
  await dom.render(<Editor active />); await ready(); await input('Mesh network', 'first-edit')
  await dom.click('[data-settings-save-bar] button')
  const sent = call.mock.calls.find(row => row[0] === 'settings.mesh.configure')!
  expect(sent[1]).toMatchObject({ expectedRevision: 'r1', configuration: { networkId: 'first-edit' } }); expect(sent[2]?.expectedOwner).toEqual(settings.owner)
  await input('Mesh network', 'later-edit')
  await act(async () => finish({ settings: { ...settings, revision: 'r2', configuration: { ...configuration, networkId: 'first-edit' } }, diskDurability: 'confirmed' }))
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Mesh network"]')!.value).toBe('later-edit')
  expect(dom.container.textContent).toContain('Mesh: unsaved changes')
  expect(call.mock.calls.filter(row => row[0] === 'settings.mesh.configure')).toHaveLength(1)
})
it('lost write ACK retains exact input and original operation across remount; inspect never resubmits', async () => {
  let submitted: any, confirmed = false
  const call = vi.spyOn(api.mesh, 'call').mockImplementation(async (method, params) => {
    if (method === 'settings.mesh.configure') { submitted = params; throw Error('lost original acknowledgement') }
    if (method === 'mesh.inspect') return observation() as never
    return { ...settings, ...(confirmed ? { revision: 'r2', configuration: submitted.configuration } : {}), operation: 'operationId' in params && confirmed ? { operationId: submitted.operationId, expectedRevision: 'r1', revision: 'r2', status: 'confirmed', updatedAt: 2 } : null } as never
  })
  await dom.render(<Editor active />); await ready(); await input('Mesh network', 'retained-edit'); await input('Original Mesh endpoint offer', '{ incomplete original offer')
  await dom.click('[data-settings-save-bar] button')
  const raw = useAppStore.getState().meshSettingsDrafts, entry = meshDraftForRuntime(raw, settings.owner.runtimeId)!
  expect(entry.pending).toMatchObject({ operationId: submitted.operationId, submitted: submitted.configuration, phase: 'unknown' })
  const restored = restoredMeshDrafts(raw); useAppStore.setState({ meshSettingsDrafts: restored })
  await dom.render(<Editor active key="restored" />); await ready()
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Mesh network"]')!.value).toBe('retained-edit')
  expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Original Mesh endpoint offer"]')!.value).toBe('{ incomplete original offer')
  expect(call.mock.calls.filter(row => row[0] === 'settings.mesh.configure')).toHaveLength(1)
  confirmed = true
  await dom.click('.mesh-pending button')
  expect(meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, settings.owner.runtimeId)?.pending).toBeUndefined()
  expect(dom.container.textContent).toContain('Original Mesh save confirmed')
})
it('refresh does not replace a draft with a foreign original Runtime or a newer saved configuration', async () => {
  const call = inspectOnly(); await dom.render(<Editor active />); await ready(); await input('Mesh network', 'keep-this')
  call.mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? observation() : { ...settings, revision: 'r2', configuration: { ...configuration, networkId: 'other-writer' } }) as never)
  await dom.click('.mesh-network-heading button'); expect(dom.container.textContent).toContain('Your edit is retained')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Mesh network"]')!.value).toBe('keep-this')
  call.mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? observation() : { ...settings, owner: { ...settings.owner, runtimeId: 'foreign' } }) as never)
  await dom.click('.mesh-network-heading button'); expect(dom.container.textContent).toContain('Another Core answered')
  expect(meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, settings.owner.runtimeId)!.form.networkId).toBe('keep-this')
})
it('opaque unreadable authored records remain retained; form code exchanges preserve pins and separate device admission', () => {
  const unreadable = { 'original-runtime': { bytes: 'original input' } }; expect(restoredMeshDrafts(unreadable)).toEqual(unreadable); expect(() => meshDraftForRuntime(unreadable, 'original-runtime')).toThrow()
  const code = meshPeerCode({ ...settings, identity: { peerId: 'peer-original', publicKey: 'public-key', epoch: 2 }, configuration: { ...configuration, advertisedIngress: [{ endpoint: 'gateway.example:443', useTls: true }] } })!
  const form = { ...meshForm(configuration), peers: code, clientKeys: 'device-public-key' }
  expect(meshConfiguration(form, configuration)).toMatchObject({ members: [{ peerId: 'peer-original', publicKey: 'public-key' }], peers: [{ peerId: 'peer-original', endpoints: [{ endpoint: 'gateway.example:443', useTls: true }] }], endpointAccess: { allowedClientKeys: ['device-public-key'] } })
  expect(() => meshConfiguration({ ...form, networkId: 'different-network' }, configuration)).toThrow('belong to this network')
})
it('production Mesh editors exchange codes and save through Renderer/Main into two real original Unix Cores; outbound-only participant authenticates and CAS rejection recovers', async () => {
  const { pathToFileURL } = await import('node:url'), { resolve } = await import('node:path'), { EventEmitter } = await import('node:events')
  const { createRequire } = await import('node:module')
  const { privateCore } = createRequire(import.meta.url)(resolve('apps/desktop/scripts/fixtures/mesh-settings/private-core.mjs'))
  const { registerMeshNetworkIpc } = await import('../src/main/mesh-network-ipc'), { createRendererMeshNetwork } = await import('../src/renderer/src/lib/mesh-network-client')
  const a = await privateCore(); let b: typeof a; try { b = await privateCore({host:true}) } catch (cause) { await a.close(); throw cause }; const cores = [a,b]
  class Sender extends EventEmitter { id=52; isDestroyed(){return false} }
  const sender=new Sender(), owners: Array<{dispose():void}>=[], calls:any[]=[]
  function connect(core: typeof a) {
    const handlers=new Map<string,(...args:any[])=>any>()
    owners.push(registerMeshNetworkIpc({handle:(name,fn)=>handlers.set(name,fn),call:async(method,params,context)=>{calls.push({core:core.owner,method,params,context});return await core.client.call(method,params,context)}}))
    let sequence=0
    const renderer=createRendererMeshNetwork({call:async(method,params,context)=>await handlers.get('mesh:call')!({sender},'original-mesh-ui-'+(++sequence),method,params,context?.expectedOwner)})
    return vi.spyOn(api.mesh,'call').mockImplementation(renderer.call)
  }
  const wait = async (read:()=>Promise<any>, check:(v:any)=>boolean) => { let value:any;for(let i=0;i<200;i++){value=await read();if(check(value))return value;await new Promise(done=>setTimeout(done,20))}throw Error('Real Mesh not observed: '+JSON.stringify(value)+' UI: '+dom.container.textContent+' calls: '+JSON.stringify(calls.map(c=>({method:c.method,params:c.params})))) }
  try {
    const initialA=await a.client.call('settings.mesh.inspect',{}), initialB=await b.client.call('settings.mesh.inspect',{})
    // First use the production editor for the original gateway, then publish its actual port.
    let bridge=connect(a); await dom.render(<Editor active key="real-a"/>);await ready()
    const chooseRole=async(value:'gateway'|'participant')=>{await dom.click(`.mesh-task-options > button:nth-child(${value==='gateway'?2:1})`)}
    await chooseRole('gateway');await dom.click('[aria-label="Own Mesh listener"]');await input('Mesh network','gui-original-network');await input('Mesh listen port','0');await dom.click('[data-settings-save-bar] button')
    await act(async()=>{await wait(()=>a.client.call('mesh.inspect',{}),v=>v.gateway.state==='listening')})
    await dom.click('.mesh-network-heading button')
    const firstA=await a.client.call('settings.mesh.inspect',{}), observedA=await a.client.call('mesh.inspect',{})
    const origin=`http://127.0.0.1:${observedA.gateway.listener.port}`
    await input('Mesh published origins',origin)
    const bCode=meshPeerCode({...initialB,configuration:{...initialB.configuration,networkId:'gui-original-network'}})!
    await input('Mesh peer codes',bCode);await dom.click('[data-settings-save-bar] button')
    const savedA=await wait(()=>a.client.call('settings.mesh.inspect',{}),v=>v.revision!==firstA.revision)
    expect(savedA.configuration.peers).toEqual([{peerId:initialB.identity.peerId,endpoints:[]}])
    const aCode=meshPeerCode(savedA)!
    bridge.mockRestore();bridge=connect(b);await dom.render(<Editor active key="real-b"/>);await ready()
    await chooseRole('participant');await input('Mesh network','gui-original-network');await input('Mesh peer codes',aCode);await input('Mesh device public keys',b.devicePublicKey);await dom.click('[data-settings-save-bar] button')
    const joined=await wait(()=>a.client.call('mesh.inspect',{}),v=>v.network?.peers.some((p:any)=>p.peerId===initialB.identity.peerId&&p.state==='connected'))
    expect(joined.network.peers[0].state).toBe('connected')
    expect((await b.client.call('settings.mesh.inspect',{})).configuration.listen).toBeUndefined()
    const originalBEndpoint=await wait(()=>b.client.call('mesh.inspect',{}),v=>v.endpoint.state==='available')
    bridge.mockRestore();bridge=connect(a);await dom.render(<Editor active key="real-a-link"/>);await ready()
    await input('Original Mesh endpoint offer',JSON.stringify(originalBEndpoint.endpoint.offer));await dom.click('[data-settings-field="mesh-link"] > button')
    await settled(()=>Boolean(dom.container.querySelector('[aria-label="Mesh access link"]')))
    const linkUrl=dom.container.querySelector<HTMLInputElement>('[aria-label="Mesh access link"]')!.value
    const linkedOffer=b.readOffer(linkUrl)
    expect(linkedOffer.serverId).toBe(originalBEndpoint.endpoint.offer.serverId);expect(linkedOffer.daemonPublicKeyB64).toBe(originalBEndpoint.endpoint.offer.daemonPublicKeyB64)
    const originalRemote=await b.relay(linkedOffer)
    expect((await originalRemote.call('runtime.owner.identity',{})).owner.runtimeId).toBe(initialB.owner.runtimeId)
    await expect(originalRemote.call('settings.mesh.inspect',{})).rejects.toMatchObject({code:'CONTROL_PERMISSION_DENIED'})
    bridge.mockRestore();bridge=connect(b);await dom.render(<Editor active key="real-b-cas"/>);await ready()
    await dom.click('.mesh-network-heading button');await settled(()=>dom.container.querySelector('.mesh-network-heading button')?.textContent==='Refresh');await input('Mesh device public keys','Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8=')
    const before=await b.client.call('settings.mesh.inspect',{})
    await b.client.call('settings.mesh.configure',{expectedRevision:before.revision,operationId:'other-original-user-save',configuration:{...before.configuration,publishers:[]}})
    const writesBefore=calls.filter(row=>row.method==='settings.mesh.configure').length
    await dom.click('[data-settings-save-bar] button')
    await settled(()=>calls.filter(row=>row.method==='settings.mesh.configure').length===writesBefore+1 && dom.container.querySelector('[data-settings-save-bar] button')?.getAttribute('aria-busy')==='false')
    expect(meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts,initialB.owner.runtimeId)?.pending).toBeUndefined()
    expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Mesh device public keys"]')!.value).toBe('Hx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8fHx8=')
    await dom.click('.mesh-network-heading button');await settled(()=>Boolean(dom.container.querySelector('.mesh-conflict')));expect(dom.container.textContent).toContain('Your edit is retained')
    expect(calls.filter(row=>row.method==='settings.mesh.configure')).toHaveLength(writesBefore+1)
    expect(initialA.owner.runtimeId).not.toBe(initialB.owner.runtimeId)
    const {writeFile}=await import('node:fs/promises');await writeFile(resolve(process.env.AGENTMUX_MESH_UI_EVIDENCE ?? '.local/state/mesh-network-access', 'ui-joined-behavior.json'),JSON.stringify({passed:true,scope:'Actual production Mesh editor→Renderer protocol wrapper→registered fixed Main IPC→original Unix Core→official private Native owners. Controlled peer endpoints only; no user Runtime touched.',originalOwners:[initialA.owner,initialB.owner],privateRoots:cores.map(c=>c.directory),privatePids:cores.flatMap(c=>c.pids),authenticatedOutboundOnly:initialB.identity.peerId,gatewayPeer:initialA.identity.peerId,casRejectedWithoutReplay:true,originalPinsRetained:true,originalHostEndpoint:originalBEndpoint.endpoint.offer.serverId,originalEncryptionKey:originalBEndpoint.endpoint.offer.daemonPublicKeyB64,guiLinkUsedByOriginalDevice:true,deviceSettingsDenied:true,methodCounts:Object.fromEntries(['settings.mesh.inspect','settings.mesh.configure','mesh.inspect'].map(method=>[method,calls.filter(c=>c.method===method).length]))},null,2))
  } finally { await dom.render(<div/>);for(const owner of owners)owner.dispose();vi.restoreAllMocks();for(const core of cores.reverse())await core.close(); const {access,writeFile}=await import('node:fs/promises'); const roots=await Promise.all(cores.map(async c=>({path:c.directory,absent:await access(c.directory).then(()=>false,()=>true)}))); const pids=cores.flatMap(c=>c.pids).map(pid=>{let exited=false;try{process.kill(pid,0)}catch(error){exited=(error as NodeJS.ErrnoException).code==='ESRCH'}return{pid,exited}});await writeFile(resolve(process.env.AGENTMUX_MESH_UI_EVIDENCE ?? '.local/state/mesh-network-access', 'ui-joined-cleanup.json'),JSON.stringify({passed:roots.every(r=>r.absent)&&pids.every(p=>p.exited),roots,pids},null,2));expect(roots.every(r=>r.absent)&&pids.every(p=>p.exited)).toBe(true) }
},90000)
it('late original endpoint link cannot appear beside later offer input', async () => {
  let finish!: (value: unknown) => void
  vi.spyOn(api.mesh,'call').mockImplementation(async method => method === 'mesh.link' ? await new Promise(done => { finish = done }) as never : structuredClone(method === 'mesh.inspect' ? observation() : settings) as never)
  await dom.render(<Editor active/>);await ready();await input('Original Mesh endpoint offer','{"serverId":"original-A"}')
  await dom.click('[data-settings-field="mesh-link"] > button')
  await input('Original Mesh endpoint offer','{"serverId":"later-B"}')
  await act(async()=>finish({url:'secret-original-A-link',offer:{serverId:'original-A'},observation:{route:{hops:2}}}))
  expect(dom.container.querySelector('[aria-label="Mesh access link"]')).toBeNull()
  expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Original Mesh endpoint offer"]')!.value).toBe('{"serverId":"later-B"}')
})
it('nested damaged baseline stays opaque in the existing draft document and reports a local issue without breaking Settings',async()=>{
  inspectOnly();const raw={'original-runtime':{baseline:{...settings,configuration:{}},form:meshForm(configuration)}}
  useAppStore.setState({meshSettingsDrafts:raw});await dom.render(<Editor active/>);await act(async()=>{await new Promise(done=>setTimeout(done,30))})
  expect(useAppStore.getState().meshSettingsDrafts).toEqual(raw)
  expect(dom.container.textContent).toContain('original Mesh edit cannot be read')
})
it('an empty listener port stays incomplete; original code membership preserves incoming-only direct peers and indirect records separately',()=>{
  expect(()=>meshConfiguration({...meshForm(configuration),role:'gateway',listen:true,port:''},configuration)).toThrow('explicit whole port')
  const peer={peerId:'direct-peer',publicKey:'public',epoch:1},own={peerId:'self-peer',publicKey:'own',epoch:1}
  const codes=[meshPeerCode({...settings,identity:peer})!,meshPeerCode({...settings,identity:own})!]
  expect(meshConfiguration({...meshForm(configuration),peers:codes.join('\n')},configuration,own).peers).toEqual([{peerId:peer.peerId,endpoints:[]}])
  const indirect={...configuration,members:[{peerId:peer.peerId,publicKey:peer.publicKey}],peers:[]}
  const form=meshForm(indirect);expect(meshConfiguration({...form,peers:form.peers+'\n'},indirect).peers).toEqual([])
  const bad={...settings,configuration:{}},raw={'original-runtime':{baseline:settings,form:meshForm(configuration),pending:{operationId:'original',expectedRevision:'r1',submitted:bad.configuration,submittedForm:{},phase:'unknown'}}}
  expect(()=>meshDraftForRuntime(raw,'original-runtime')).toThrow();expect(restoredMeshDrafts(raw)).toEqual(raw)
})

it('hiding a pending route read releases its observer and allows an explicit fresh read after return without replaying it',async()=>{
 let finish!:(value:unknown)=>void
 const call=vi.spyOn(api.mesh,'call').mockImplementation(async method=>method==='mesh.link'?await new Promise(done=>{finish=done}) as never:structuredClone(method==='mesh.inspect'?observation():settings) as never)
 await dom.render(<Editor active/>);await ready();await input('Original Mesh endpoint offer','{"serverId":"original-A"}');await dom.click('[data-settings-field="mesh-link"] > button')
 expect(dom.container.querySelector('[data-settings-field="mesh-link"] > button')?.textContent).toBe('Reading route…')
 await dom.render(<Editor active={false}/>);await dom.render(<Editor active/>)
 expect(dom.container.querySelector<HTMLButtonElement>('[data-settings-field="mesh-link"] > button')!.disabled).toBe(false)
 expect(call.mock.calls.filter(row=>row[0]==='mesh.link')).toHaveLength(1)
 await act(async()=>finish({url:'old-request-link',offer:{serverId:'original-A'},observation:{route:{hops:2}}}))
 expect(dom.container.querySelector('[aria-label="Mesh access link"]')).toBeNull()
 expect(dom.container.querySelector<HTMLTextAreaElement>('[aria-label="Original Mesh endpoint offer"]')!.value).toBe('{"serverId":"original-A"}')
})

it('unavailable setup offers recovery and the original saved connections without an invented empty network or dead link form', async () => {
  const call = vi.spyOn(api.mesh, 'call').mockRejectedValue(Object.assign(Error('Original owner did not answer'), { code: 'MESH_OWNER_UNAVAILABLE' }))
  await dom.render(<hostsSettingsModule.Pane config={useAppStore.getState().config!} active onClose={vi.fn()} onNavigate={vi.fn()} navigationRequest={{section:'hosts',field:'mesh-configuration'}} />)
  await settled(() => Boolean(dom.container.querySelector('.mesh-availability details')))
  expect(dom.container.textContent).toContain('Couldn’t read Mesh settings.')
  expect(dom.container.textContent).not.toContain('Reading your network settings…')
  expect(dom.container.querySelector('.mesh-network-map')).toBeNull()
  expect(dom.container.querySelector('[data-settings-field="mesh-link"]')).toBeNull()
  expect(dom.container.querySelector('[data-mesh-view="connections"]')?.hasAttribute('hidden')).toBe(true)
  await dom.click('.mesh-recovery-actions button:last-child')
  expect(dom.container.querySelector('[data-mesh-view="connections"]')?.hasAttribute('hidden')).toBe(false)
  expect(dom.container.querySelector('[data-mesh-home-view]')?.getAttribute('data-mesh-home-view')).toBe('connections')
  expect(dom.container.querySelector('.mesh-editor-navigation')?.textContent).toContain('Device connections')
  expect(call.mock.calls.some(row => row[0] === 'settings.mesh.configure')).toBe(false)
})

it('independent authenticated network observations survive an unavailable settings reader', async () => {
  const live = observation()
  live.network = { protocol: 1, state: 'active', networkId: 'original-network', identity: { peerId: 'original-peer', publicKey: 'public', epoch: 1 }, peers: [{ peerId: 'other-peer', state: 'connected', rttMs: 13, connectionId: 'original-link' }], records: [], routes: [], circuits: [] }
  vi.spyOn(api.mesh, 'call').mockImplementation(async method => {
    if (method === 'settings.mesh.inspect') throw Error('Settings reader unavailable')
    return structuredClone(live) as never
  })
  await dom.render(<Editor active />)
  await settled(() => Boolean(dom.container.querySelector('.mesh-availability details')))
  await settled(() => Boolean(dom.container.querySelector('[data-mesh-object="peer"]')))
  expect(dom.container.textContent).toContain('Couldn’t read Mesh settings.')
  expect(dom.container.textContent).toContain('other-peer')
  expect(dom.container.textContent).toContain('Authenticated')
  expect(dom.container.textContent).not.toContain('No direct peers configured.')
})

it('connection tasks edit a retained draft before a deliberate save; failed observation keeps the original authored fields', async () => {
  const call = inspectOnly()
  await dom.render(<Editor active />); await ready()
  await dom.click('.mesh-task-options > button:nth-child(2)')
  expect(meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, settings.owner.runtimeId)?.form.role).toBe('gateway')
  expect(call.mock.calls.filter(row => row[0] === 'settings.mesh.configure')).toHaveLength(0)
  await input('Mesh network', 'authored-network  ')
  call.mockImplementation(async () => { throw Error('Temporary read failure') })
  await dom.click('.mesh-network-heading button')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Mesh network"]')!.value).toBe('authored-network  ')
  expect(dom.container.querySelector('.mesh-task-options > button:nth-child(2)')?.getAttribute('aria-pressed')).toBe('true')
  expect(dom.container.textContent).toContain('Network observation unavailable.')
  expect(call.mock.calls.filter(row => row[0] === 'settings.mesh.configure')).toHaveLength(0)
})

it('a newly confirmed owner never adopts an earlier network snapshot as its current listener', async () => {
  let finishSettings!: (value: unknown) => void, finishNetwork!: (value: unknown) => void, reads = 0
  const oldView = { ...observation(), gateway: { state: 'listening', listener: { host: '127.0.0.1', port: 9301, protocol: 'http' } } }
  vi.spyOn(api.mesh, 'call').mockImplementation(async method => {
    if (method === 'settings.mesh.inspect') return await new Promise(done => { finishSettings = done }) as never
    if (++reads === 1) return structuredClone(oldView) as never
    return await new Promise(done => { finishNetwork = done }) as never
  })
  await dom.render(<Editor active />)
  await settled(() => dom.container.textContent?.includes('Listening on 127.0.0.1:9301') ?? false)
  const restarted = { ...settings, owner: { ...settings.owner, ownerInstanceId: 'new-original-process' } }
  await act(async () => finishSettings(restarted)); await ready()
  expect(dom.container.textContent).not.toContain('Listening on 127.0.0.1:9301')
  expect(dom.container.querySelector('.mesh-network-status')).toBeNull()
  await act(async () => finishNetwork(observation(restarted)))
  expect(dom.container.querySelector('.mesh-network-status')?.textContent).toContain('Mesh active')
})

it('choosing gateway again preserves its authored listener mode and explicitly copies only saved connection details', async () => {
  const savedIdentity = { ...settings, identity: { peerId: 'saved-peer', publicKey: 'saved-public-key', epoch: 1 } }
  vi.spyOn(api.mesh, 'call').mockImplementation(async method => structuredClone(method === 'mesh.inspect' ? observation(savedIdentity) : savedIdentity) as never)
  const clipboard = vi.spyOn(api.ui, 'writeClipboardText').mockResolvedValue(undefined)
  await dom.render(<Editor active />); await ready()
  await dom.click('.mesh-task-options > button:nth-child(2)')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Own Mesh listener"]')!.checked).toBe(false)
  await input('Mesh published origins', 'http://new-unshared-gateway:8444')
  await dom.click('.mesh-task-options > button:nth-child(2)')
  expect(dom.container.querySelector<HTMLInputElement>('[aria-label="Own Mesh listener"]')!.checked).toBe(false)
  expect(meshDraftForRuntime(useAppStore.getState().meshSettingsDrafts, settings.owner.runtimeId)?.form.ingress).toBe('http://new-unshared-gateway:8444')
  expect(dom.container.querySelector('.mesh-code-action button')?.textContent).toBe('Copy saved connection code')
  expect(dom.container.querySelector('.mesh-code-action')?.textContent).toContain('Save changes before sharing')
  await dom.click('.mesh-code-action button')
  expect(clipboard).toHaveBeenCalledWith(meshPeerCode(savedIdentity))
})
