import{createHash}from'node:crypto'
import{appendFileSync,readFileSync}from'node:fs'
import{resolve}from'node:path'
const root=resolve(import.meta.dirname,'../../..'),variants={
 'dispatch-fence':['packages/core/src/public-rpc-service.ts','if (requestedMoteAddress) await operationContext.assertCurrent?.()','void requestedMoteAddress'],
 'nav-binding':['packages/core/src/desktop-focus-parser.ts','if (address && (!link ||','if (false && (!link ||'],
 'ipc-runtime':['apps/desktop/src/main/ipc.ts',"const request = original ?? parseSpaceLinkParams('space.link.ensure'","const request = parseSpaceLinkParams('space.link.ensure'"],
 'skip-persistence':['packages/core/src/spatial-state.ts','await this.writeLocked(current, parseAgentMuxSpatialGraph(graph))\n      return { runtimeId: target.runtimeId, linkId }','void current\n      return { runtimeId: target.runtimeId, linkId }'],
 'wrong-runtime':['packages/core/src/public-rpc-service.ts','if (owner.runtimeId !== expectedRuntime)', 'if (false)'],
 'remap-operation':['packages/core/src/spatial-state.ts','if (previous && !same(document.records[previous]!))','if (false)'],
 'drop-owned':['packages/core/src/spatial-state.ts',"if (key.startsWith('owned:')) graph.resources[key] = value", "if (key.startsWith('owned:') && key !== SPACE_LINK_RESOURCE) graph.resources[key] = value"],
 'copy-path':['apps/desktop/src/renderer/src/lib/mote-address-copy.ts','copyTextToClipboard(confirmed.url,reportError)',"copyTextToClipboard('amux://mote/'+encodeURIComponent(target.spaceId),reportError)"],
 'resolve-ensure':['packages/core/src/spatial-state.ts','if (!target) return null',"if (!target) throw new AgentMuxError('Unexpected registration instead of a missing read','MUTATED_RESOLVE')"],
 'wrong-navigation':['packages/core/src/public-rpc-service.ts',"request.target = {kind:'mote',spaceId:resolved.target.spaceId", "request.target = {kind:'mote',spaceId:'wrong-original-target'"],
 'ingress-token':['apps/desktop/src/main/spatial-link-ingress.ts','request = { ...base, target }',"request = { ...base, target: target.address ? {kind:'mote',spaceId:target.address.linkId} : target }"]
}
export function transformMoteLinkSource(code,path,loader){
 if(!['packages/core/src/desktop-focus-parser.ts','apps/desktop/src/renderer/src/components/MoteQuickMode.tsx','apps/desktop/src/renderer/src/components/MoteHeartbeatStatus.tsx','apps/desktop/src/renderer/src/components/SessionMailbox.tsx','packages/core/src/space-link.ts','packages/core/src/space-link-cli.ts','packages/core/src/spatial-state.ts','packages/core/src/sharing.ts','packages/core/src/public-rpc-service.ts','apps/desktop/src/main/spatial-link-ingress.ts','apps/desktop/src/renderer/src/lib/mote-address-copy.ts','apps/desktop/src/main/ipc.ts','apps/desktop/src/preload/index.ts'].includes(path))return code
 const original=code,mutation=process.env.MOTE_LINK_MUTATION,spec=variants[mutation]
 if(mutation&&!spec)throw Error('Unknown original link source mutation')
 if(spec?.[0]===path){const count=code.split(spec[1]).length-1;if(count!==1)throw Error('Expected exactly one loaded link mutation: '+mutation+' got '+count);code=code.replace(spec[1],spec[2])}
 const hash=b=>createHash('sha256').update(b).digest('hex')
 if(process.env.MOTE_LINK_LOADED)appendFileSync(process.env.MOTE_LINK_LOADED,JSON.stringify({path,loader,pid:process.pid,rawSHA256:hash(readFileSync(resolve(root,path))),originalSHA256:hash(original),loadedSHA256:hash(code),...(code===original?{}:{mutation})})+'\n')
 return code
}
