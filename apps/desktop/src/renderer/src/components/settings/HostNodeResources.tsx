import type { NodeResources } from '@agentmux/core/node-publishing'
import { HostResourceTrends } from './HostResourceTrends'
import { nodeTrendPoints, type NodeSampleFrame } from './node-resource-view'
function bytes(value:number){return new Intl.NumberFormat(undefined,{maximumFractionDigits:1}).format(value/1024**3)+' GiB'}
function when(at:number){return new Date(at).toLocaleTimeString()}
export function HostNodeResources({reply,frames,error,busy,active,privateOwner=false}:{reply?:NodeResources|undefined;frames:NodeSampleFrame[];error?:string|undefined;busy:boolean;active:boolean;privateOwner?:boolean}){
  const points=nodeTrendPoints(frames),sample=[...frames].reverse().find(frame=>frame.sample)?.sample,now=points.at(-1)
  const withheld=reply?.status==='withheld',retained=Boolean(error||reply?.status==='unavailable')
  const hostCpu=retained?[...points].reverse().find(point=>point.hostCpu!==null)?.hostCpu:now?.hostCpu
  const coreCpu=retained?[...points].reverse().find(point=>point.coreCpu!==null)?.coreCpu:now?.coreCpu
  const memorySample=[...frames].reverse().find(frame=>frame.sample?.memory.state==='available')?.sample
  const processSample=[...frames].reverse().find(frame=>frame.sample?.process.state==='available')?.sample
  const sources=sample?[sample.system,sample.cpu,sample.memory,sample.filesystem,sample.process]:[]
  return <section className="host-node-resources" aria-label="Node resource measurements">
    <header><strong>Device resources</strong><span>{privateOwner?'Private owner view':'Published by this node'}</span></header>
    {withheld?<p className="network-node-feedback" role="status">System resources are not shared by this node. Existing work remains available.</p>:<>
      <p className="host-runtime__sample" role="status">{retained?`Observation unavailable.${sample?` Last confirmed ${when(sample.observedAt)}.`:''}`:sample?`Sample ${when(sample.observedAt)} · recent samples while this panel is open`:busy?'Reading resource measurements…':'No confirmed samples yet.'}</p>
      {error||reply?.status==='unavailable'?<p className="host-runtime__issue">{error??(reply?.status==='unavailable'?reply.message:'')}</p>:null}
      <div className="host-node-resources__values">
        <div><span>Host CPU</span><strong>{hostCpu==null?'—':hostCpu.toFixed(1)+'%'}</strong><small>{hostCpu!=null?'Measured interval':sample?'Waiting for the next compatible sample':'Not observed'}</small></div>
        <div><span>Host memory in use</span><strong>{memorySample?.memory.state==='available'?bytes(memorySample.memory.value.totalBytes-memorySample.memory.value.freeBytes):'—'}</strong><small>{memorySample?.memory.state==='available'?`of ${bytes(memorySample.memory.value.totalBytes)} · includes cache${sample?.memory.state!=='available'?` · last ${when(memorySample.observedAt)}`:''}`:'Not observed'}</small></div>
        <div><span>Core process CPU</span><strong>{coreCpu==null?'—':coreCpu.toFixed(1)+'%'}</strong><small>One logical core = 100%</small></div>
        <div><span>Core process memory</span><strong>{processSample?.process.state==='available'?bytes(processSample.process.value.rssBytes):'—'}</strong><small>Resident memory · RSS{processSample&&sample?.process.state!=='available'?` · last ${when(processSample.observedAt)}`:''}</small></div>
      </div>
      {sources.flatMap((source,index)=>source.state==='unavailable'?[<p key={index} className="host-runtime__issue">{source.message}</p>]:[])}
      {sample?<><HostResourceTrends points={points} active={active}/><details className="host-runtime__details"><summary>Samples &amp; resource details</summary><p className="host-runtime__sample">Host uptime {sample.system.state==='available'?Math.floor(sample.system.value.uptimeSeconds/3600)+' h':'not observed'} · Filesystem {sample.filesystem.state==='available'?`${bytes(sample.filesystem.value.availableBytes)} available / ${bytes(sample.filesystem.value.totalBytes)}`:'not observed'}. Filesystem source: {sample.filesystem.state==='available'&&sample.filesystem.value.root?'published root':'Node storage volume'}.</p><div className="host-node-resources__table"><table><thead><tr><th>Time</th><th>Host CPU</th><th>Core CPU</th><th>Host RAM GiB</th><th>Core RSS GiB</th></tr></thead><tbody>{[...points].reverse().map((point,index)=><tr key={`${point.at}:${index}`}><td>{when(point.at)}</td><td>{point.hostCpu?.toFixed(1)??'—'}</td><td>{point.coreCpu?.toFixed(1)??'—'}</td><td>{point.memoryGiB?.toFixed(2)??'—'}</td><td>{point.coreGiB?.toFixed(2)??'—'}</td></tr>)}</tbody></table></div></details></>:null}
    </>}
  </section>
}
