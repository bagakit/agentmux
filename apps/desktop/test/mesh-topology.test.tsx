import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Root } from 'react-dom/client'
import type { MeshNetworkInspection } from '@agentmux/core/mesh-network'
import { createClientUiRoot } from './helpers/client-ui-render'
import { MeshNetworkMap } from '../src/renderer/src/components/settings/MeshNetworkMap'
import { meshTopologyModel } from '../src/renderer/src/components/settings/mesh-topology'
const ids = ['peer-original', 'peer-gateway', 'peer-destination']
function observation(): MeshNetworkInspection {
  const record = (index: number, peers: number[]) => ({ version: 1 as const, networkId: 'work-machines', originPeerId: ids[index]!, epoch: 7, revision: 5, signature: 'fixture-signed', advertisedIngress: index === 1 ? [{ endpoint: 'gateway.internal:8444', useTls: false }] : [], neighbors: peers.map(n => ({ peerId: ids[n]!, peerEpoch: 7, connectionId: [index,n].sort().join('-'), rttMs: 11 })), publishers: index === 2 ? [{ serverId: 'original-endpoint', generation: 'publisher-original' }] : [] })
  return { owner: { runtimeId: 'original-runtime', ownerInstanceId: 'original-process' }, identity: { peerId: ids[0]!, publicKey: 'public-peer', epoch: 7 }, source: 'managed', activeRevision: 'r1', desiredRevision: 'r1', apply: { state: 'active' }, gateway: { state: 'disabled' }, endpoint: { state: 'not-provided' }, coverage: { configuredOrigins: 3, observedOrigins: 3, complete: true }, observedAt: 1000,
    network: { protocol: 1, state: 'active', networkId: 'work-machines', identity: { peerId: ids[0]!, publicKey: 'public-peer', epoch: 7 }, peers: [{ peerId: ids[1]!, state: 'connected', connectionId: '0-1', rttMs: 11 }], records: [record(0,[1,2]),record(1,[0,2]),record(2,[0,1])], routes: [{ serverId: 'original-endpoint', originPeerId: ids[2]!, publisherGeneration: 'publisher-original', path: [ids[0]!,ids[2]!], hops: 1, rttMs: 14, advertisedIngress: [] }], circuits: [{ circuitId: 'circuit-original', serverId: 'original-endpoint', path: ids }] } }
}
class LayoutWorker {
  static instances: LayoutWorker[] = []
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  terminated = false
  input: { id: string; input: { nodes: { id: string }[] } } | undefined
  constructor() { LayoutWorker.instances.push(this) }
  postMessage(input: LayoutWorker['input']) { this.input = input }
  terminate() { this.terminated = true }
  reply() { this.onmessage?.({ data: { id: this.input!.id, positions: Object.fromEntries(this.input!.input.nodes.map((n,i) => [n.id,{x:i*240,y:40}])) } }) }
}
let container: HTMLDivElement, root: Root
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('Worker', LayoutWorker); LayoutWorker.instances = []; container = document.createElement('div'); document.body.append(container); root = createClientUiRoot(container) })
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
async function render(snapshot = observation(), active = true) { await act(async () => root.render(<MeshNetworkMap snapshot={snapshot} active={active} />)) }
async function click(selector: string) { await act(async () => { const element = container.querySelector<HTMLElement>(selector); expect(element, selector).not.toBeNull(); element!.click() }) }
async function search(value: string) { await act(async () => { const input = container.querySelector<HTMLInputElement>('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);input.dispatchEvent(new Event('input',{bubbles:true})) }) }

it('actual map consumer draws only reciprocal generation-matched links, retaining one-sided peers without declaring them healthy', async () => {
  const snapshot = observation(); snapshot.network!.records[1]!.neighbors[0]!.connectionId = 'other-generation'
  await render(snapshot)
  expect(container.querySelector('.mesh-explorer__header')?.textContent).toContain('2 reciprocal links')
  expect(meshTopologyModel(snapshot).edges.some(edge => edge.source === ids[0] && edge.target === ids[1])).toBe(false)
  await click('[data-mesh-object="route"]')
  expect(container.querySelector('[aria-label="Selected endpoint network path"]')?.textContent).toContain('peer-destination')
  expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('Available route RTT')
})

it('available routes and adopted circuits keep distinct exact paths through the production graph and list', async () => {
  await render(); await click('[data-mesh-object="route"]')
  expect(container.querySelector('[aria-label="Selected endpoint network path"]')!.children).toHaveLength(2)
  await click('.mesh-explorer__categories button:nth-child(3)'); await click('[data-mesh-object="circuit"]')
  expect(container.querySelector('[aria-label="Selected endpoint network path"]')!.children).toHaveLength(3)
  expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('ADOPTED CIRCUIT')
  await click('[aria-label="Network view"] button:nth-child(2)')
  expect(container.querySelector('[data-mesh-object="circuit"]')?.getAttribute('aria-pressed')).toBe('true')
  await click('[aria-label="Network scope"] button:nth-child(2)')
  expect(container.querySelector('[aria-label="Selected endpoint network path"]')!.children).toHaveLength(3)
})

it('search absence is explicit and keeps the selected identity; peer directory remains keyboard-operable with exact observations', async () => {
  await render(); await click('[data-mesh-object="route"]'); await search('no-such-network-object')
  expect(container.textContent).toContain('No matching objects in this category')
  expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('original-endpoint')
  await click('.mesh-explorer__search-result button'); await click('.mesh-explorer__categories button:first-child')
  const button = container.querySelector<HTMLButtonElement>('[data-mesh-object="peer"]')!;button.focus();expect(document.activeElement).toBe(button)
  await click('[data-mesh-object="peer"]')
  expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('Peer identity')
})

it('status polling preserves geometry and selection; hiding stops only its layout worker; an original owner change isolates selection', async () => {
  const snapshot = observation(); await render(snapshot); expect(LayoutWorker.instances).toHaveLength(1)
  await act(async () => LayoutWorker.instances[0]!.reply())
  await click('[data-mesh-object="route"]')
  await render({ ...snapshot, observedAt: 2000, network: { ...snapshot.network!, peers: snapshot.network!.peers.map(peer => ({ ...peer, rttMs: 27 })) } })
  expect(LayoutWorker.instances).toHaveLength(1)
  expect(container.querySelector('[data-mesh-object="route"]')?.getAttribute('aria-pressed')).toBe('true')
  await render(snapshot, false); expect(LayoutWorker.instances.every(worker => worker.terminated)).toBe(true)
  await render({ ...snapshot, owner: { ...snapshot.owner, ownerInstanceId: 'restarted-original-owner' } })
  expect(container.querySelector('[data-mesh-object="route"]')?.getAttribute('aria-pressed')).toBe('false')
  expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('Follow the path')
})

it('a disappeared selected circuit remains an explicitly unobserved identity rather than silently selecting another path', async () => {
  const snapshot = observation(); await render(snapshot); await click('.mesh-explorer__categories button:nth-child(3)'); await click('[data-mesh-object="circuit"]')
  await render({ ...snapshot, network: { ...snapshot.network!, circuits: [] } })
  expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('no longer in the current observation')
  expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('circuit-original')
  expect(container.querySelector('[aria-label="Selected endpoint network path"]')).toBeNull()
})

it('an actual original Core mesh observation reaches the production explorer and selects an authenticated peer', async () => {
  const { createRequire } = await import('node:module'), { resolve } = await import('node:path'), { writeFile, access, readFile } = await import('node:fs/promises'), { createHash } = await import('node:crypto')
  const { privateCore } = createRequire(import.meta.url)(resolve('apps/desktop/scripts/fixtures/mesh-settings/private-core.mjs'))
  const cores: any[] = [], evidence = resolve(process.env.AGENTMUX_MESH_TOPOLOGY_EVIDENCE ?? '.local/state/mesh-topology-interaction/tests')
  try {
    const a = await privateCore(); cores.push(a); const b = await privateCore(); cores.push(b)
    const savedA = await a.client.call('settings.mesh.inspect', {}), savedB = await b.client.call('settings.mesh.inspect', {})
    const members = [savedA.identity, savedB.identity].map(({peerId,publicKey}: {peerId:string;publicKey:string}) => ({peerId,publicKey}))
    const configuration = { ...savedA.configuration, networkId: 'original-topology-consumer', role: 'gateway', members, peers: [{ peerId: savedB.identity.peerId, endpoints: [] }], listen: { host: '127.0.0.1', port: 0 } }
    await a.client.call('settings.mesh.configure', { operationId: 'topology-original-gateway', expectedRevision: savedA.revision, configuration })
    const wait = async (read: () => Promise<any>, check: (v:any) => boolean) => { let value;for(let i=0;i<200;i++){value=await read();if(check(value))return value;await new Promise(done=>setTimeout(done,20))}throw Error('Original network observation did not settle: '+JSON.stringify(value)) }
    const listener = await wait(() => a.client.call('mesh.inspect', {}), value => value.gateway.state === 'listening')
    await b.client.call('settings.mesh.configure', { operationId: 'topology-original-participant', expectedRevision: savedB.revision, configuration: { ...savedB.configuration, networkId: configuration.networkId, role: 'participant', members, peers: [{ peerId: savedA.identity.peerId, endpoints: [{ endpoint: '127.0.0.1:'+listener.gateway.listener.port, useTls: false }] }] } })
    const actual = await wait(() => a.client.call('mesh.inspect', {}), value => value.network?.peers.some((peer:any)=>peer.state==='connected') && meshTopologyModel(value).edges.length === 1)
    await render(actual)
    expect(container.querySelector('.mesh-explorer__header')?.textContent).toContain('original-topology-consumer')
    expect(container.querySelector('.mesh-explorer__header')?.textContent).toContain('1 reciprocal link')
    await click('[data-mesh-object="peer"]:not([aria-pressed=true])')
    await click('.mesh-peer-list li:nth-child(2) button')
    expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain(savedB.identity.peerId)
    expect(container.querySelector('[aria-label="Selected network object"]')?.textContent).toContain('Authenticated')
    expect(container.textContent).toContain(actual.owner.runtimeId)
    const digest = async(path:string)=>createHash('sha256').update(await readFile(path)).digest('hex')
    const files = ['apps/desktop/src/renderer/src/components/settings/MeshNetworkMap.tsx','apps/desktop/src/renderer/src/components/settings/mesh-topology.ts','packages/core/dist/public-rpc-client.js','packages/core/dist/public-rpc-relay-gateway.js','packages/core/dist/headless-runtime-cli.js','packages/relay/dist/mesh-network.js']
    await writeFile(resolve(evidence,'actual-core-consumer.json'),JSON.stringify({passed:true,boundary:'Current production explorer source consumes actual original Core processes and official private Native via public Unix client; Core processes use exact existing dist recorded here, not a new build or Farm deployment.',owners:[savedA.owner,savedB.owner],peerIds:[savedA.identity.peerId,savedB.identity.peerId],networkId:actual.network.networkId,reciprocalLinks:meshTopologyModel(actual).edges.length,pids:cores.flatMap(c=>c.pids),directories:cores.map(c=>c.directory),hashes:Object.fromEntries(await Promise.all(files.map(async path=>[path,await digest(path)])))},null,2))
  } finally {
    await act(async () => root.render(<div />));for(const core of cores.reverse())await core.close()
    const directories=await Promise.all(cores.map(async c=>({path:c.directory,absent:await access(c.directory).then(()=>false,()=>true)}))),pids=cores.flatMap(c=>c.pids).map(pid=>{let exited=false;try{process.kill(pid,0)}catch(error){exited=(error as NodeJS.ErrnoException).code==='ESRCH'}return{pid,exited}})
    await writeFile(resolve(evidence,'actual-core-cleanup.json'),JSON.stringify({passed:directories.every(d=>d.absent)&&pids.every(p=>p.exited),directories,pids},null,2))
    expect(directories.every(d=>d.absent)&&pids.every(p=>p.exited)).toBe(true)
  }
},90000)


it('an unobserved network keeps a compact source and directory without empty canvas tools', async () => {
  await render({ ...observation(), network: null, apply: { state: 'disabled' } })
  expect(container.querySelector('.mesh-explorer__canvas')).toBeNull()
  expect(container.querySelector('[aria-label="Fit observed topology"]')).toBeNull()
  expect(container.querySelector('[aria-label="Network objects"]')).not.toBeNull()
  expect(container.textContent).toContain('Mesh participation is disabled')
  expect(container.textContent).toContain('original-runtime')
})

it('a circuit search keeps its adopted path legible on the graph while unrelated peers may dim', async () => {
  await render(); await click('.mesh-explorer__categories button:nth-child(3)'); await click('[data-mesh-object="circuit"]'); await search('circuit-original')
  expect(container.querySelectorAll('.mesh-explorer-node')).toHaveLength(3)
  expect(container.querySelectorAll('.mesh-explorer-node[data-on-path]')).toHaveLength(3)
  expect(container.querySelectorAll('.mesh-explorer-node[data-dimmed]')).toHaveLength(0)
  expect(container.querySelector('[aria-label="Selected endpoint network path"]')!.children).toHaveLength(3)
})
