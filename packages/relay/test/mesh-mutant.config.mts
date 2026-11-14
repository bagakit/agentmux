import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.mesh.config.mts'

const root=resolve(import.meta.dirname,'../../..')
const mode=process.env.RELAY_MESH_MUTANT
const report=process.env.RELAY_MESH_LOADED
const mutations:Record<string,[string,string]>={
  'origin-signature':['!verifyMesh(rawRecord(record),record.signature,pin.publicKey)','false'],
  'reciprocal-edge':['ab.connectionId!==ba.connectionId||',''],
  'circuit-origin':['!verifyMesh({purpose:\'agentmux-relay-mesh-circuit/1\',networkId:config.networkId,circuitId:p.circuitId,route,edges},p.signature,origin.publicKey)','false'],
  'peer-proof':['!verifyMesh(this.proofBody(link),frame.signature,config.members.find(m=>m.peerId===link.peerId)!.publicKey)','false'],
  'stale-revision':['if(prior && (record.epoch<prior.epoch || record.epoch===prior.epoch && record.revision<=prior.revision))return','if(false)return'],
  'duplicate-opening':['this.openings.has(open.circuitId)','false'],
  'adjacency-budget':['const index = c.path.indexOf(self); return c.path[index - 1] === id || c.path[index + 1] === id;','return c.path.includes(id);'],
  'guard-bypass':['spawn(command, args,',"spawn(process.execPath, ['-e', hold],"],
  'revoked-circuit':[' circuit.socket.terminate()',' void circuit.socket'],
  'frozen-path':['this.config = next','this.config = next; if(previous && next && next.peers.length>previous.peers.length) for(const circuit of this.circuits.values()) if(circuit.path.length>2)circuit.socket.terminate()'],
}
if(mode&&!mutations[mode])throw Error('Unknown Mesh mutation')
export default defineConfig({...base,plugins:[{name:'mesh-actual-source',enforce:'pre',transform(original,id){
  const path=relative(root,id.split('?')[0]!)
  if(!['packages/relay/src/mesh-network.ts','packages/relay/src/mesh-state-guard.ts','packages/relay/test/mesh-network.test.ts','packages/relay/test/mesh-state.test.ts'].includes(path))return
  let source=original
  if(mode&&path===(mode==='guard-bypass'?'packages/relay/src/mesh-state-guard.ts':'packages/relay/src/mesh-network.ts')){
    const [anchor,replacement]=mutations[mode]!
    const pattern=new RegExp([...anchor.replace(/\s/gu,'')].map(character=>character.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')).join('\\s*'),'gu')
    if([...source.matchAll(pattern)].length!==1)throw Error('Mesh mutation must load exactly one anchor: '+mode)
    source=source.replace(pattern,()=>replacement)
  }
  const sha=(value:string)=>createHash('sha256').update(value).digest('hex')
  if(report)appendFileSync(report,JSON.stringify({path,originalSHA256:sha(original),servedSHA256:sha(source),...(source===original?{}:{mode})})+'\n')
  return source===original?undefined:{code:source,map:null}
}}]})
