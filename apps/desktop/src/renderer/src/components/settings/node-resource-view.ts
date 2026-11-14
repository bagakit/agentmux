import type { NodeResourceSample } from '@agentmux/core/node-publishing'
export type NodeSampleFrame = { at: number; sample: NodeResourceSample | null }
export type NodeTrendPoint = { at: number; hostCpu: number | null; coreCpu: number | null; memoryGiB: number | null; coreGiB: number | null }
const total = (cpu: NodeResourceSample['cpu'] & { state: 'available' }) => cpu.value.userMs + cpu.value.niceMs + cpu.value.systemMs + cpu.value.idleMs + cpu.value.irqMs
export function sameNodeProcess(a: NodeResourceSample, b: NodeResourceSample) {
  return a.node.runtimeId === b.node.runtimeId && a.node.ownerInstanceId === b.node.ownerInstanceId && a.processId === b.processId
}
/** Only comparable cumulative producer samples form an interval. Missing points remain gaps. */
export function nodeTrendPoints(frames: readonly NodeSampleFrame[]): NodeTrendPoint[] {
  return frames.map(({at,sample},index) => {
    const previous=frames[index-1]?.sample
    let hostCpu: number|null=null,coreCpu: number|null=null
    if(sample&&previous&&sameNodeProcess(sample,previous)&&sample.observedAt>previous.observedAt){
      if(sample.cpu.state==='available'&&previous.cpu.state==='available'&&sample.cpu.value.logicalCpus===previous.cpu.value.logicalCpus){
        const dt=total(sample.cpu)-total(previous.cpu),idle=sample.cpu.value.idleMs-previous.cpu.value.idleMs
        if(dt>0&&idle>=0&&idle<=dt&&(['userMs','niceMs','systemMs','idleMs','irqMs'] as const).every(key=>sample.cpu.state==='available'&&previous.cpu.state==='available'&&sample.cpu.value[key]>=previous.cpu.value[key]))hostCpu=100*(dt-idle)/dt
      }
      if(sample.process.state==='available'&&previous.process.state==='available'){
        const delta=sample.process.value.cpuUserMicros+sample.process.value.cpuSystemMicros-previous.process.value.cpuUserMicros-previous.process.value.cpuSystemMicros
        if(delta>=0&&sample.process.value.cpuUserMicros>=previous.process.value.cpuUserMicros&&sample.process.value.cpuSystemMicros>=previous.process.value.cpuSystemMicros)coreCpu=delta/(sample.observedAt-previous.observedAt)/10
      }
    }
    return {at,hostCpu,coreCpu,memoryGiB:sample?.memory.state==='available'?(sample.memory.value.totalBytes-sample.memory.value.freeBytes)/1024**3:null,coreGiB:sample?.process.state==='available'?sample.process.value.rssBytes/1024**3:null}
  })
}
export function appendNodeSample(frames: readonly NodeSampleFrame[], sample: NodeResourceSample): NodeSampleFrame[] {
  const last=[...frames].reverse().find(frame=>frame.sample)?.sample
  const original=last&&!sameNodeProcess(last,sample)?[]:frames
  if(original.at(-1)?.at===sample.observedAt)return [...original]
  return [...original,{at:sample.observedAt,sample}].slice(-120)
}
