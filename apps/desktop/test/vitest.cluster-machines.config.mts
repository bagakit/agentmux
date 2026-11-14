import { defineConfig } from 'vitest/config'
import { appendFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative } from 'node:path'
import { aliases, installedDependency, root } from '../scripts/fixtures/settings-resource-library/environment.mjs'
const directory=resolve(process.env.AGENTMUX_CLUSTER_EVIDENCE??'.local/state/mesh-cluster-overview/machines-tests');mkdirSync(directory,{recursive:true})
const mode=process.env.AGENTMUX_CLUSTER_MUTANT
const edits:Record<string,[string,string,string]>={
 'no-public-source':['cluster-resource-observation.ts',"access = 'published'; reply = await port.call('node.resources', { hostId: host.id, expectedRuntimeId: runtimeId! }, signal)","throw cause"],
 'wrong-runtime':['cluster-resource-observation.ts','if (reply.node.runtimeId !== runtimeId ||','if (false && (reply.node.runtimeId !== runtimeId ||'],
 'ignore-active':['ClusterMachinesPane.tsx','if (!active || !visible) return','if (!visible) return'],
}
if(mode&&!edits[mode])throw Error('Unknown cluster mutant')
export default defineConfig({root,define:{__AGENTMUX_WEB_PREVIEW__:'true'},resolve:{alias:aliases},plugins:[{name:'actual-cluster-consumer',enforce:'pre',resolveId:installedDependency,transform(input,id){if(!id.startsWith(root+'/')||id.includes('/node_modules/')||id.includes('?')||!/\.[cm]?[jt]sx?$/.test(id))return;const path=relative(root,id),hash=(s:string)=>createHash('sha256').update(s).digest('hex');appendFileSync(resolve(directory,'consumed.jsonl'),JSON.stringify({path,sha256:hash(input)})+'\n');if(!mode||!id.endsWith('/settings/'+edits[mode]![0]))return;let [,from,to]=edits[mode]!;if(input.split(from).length!==2)throw Error('Cluster mutation must match one loaded owner');let output=input.replace(from,to);if(mode==='wrong-runtime')output=output.replace("reply.sample.policyRevision !== reply.policyRevision)) {","reply.sample.policyRevision !== reply.policyRevision))) {");appendFileSync(resolve(directory,'mutation.jsonl'),JSON.stringify({mode,path,before:hash(input),after:hash(output)})+'\n');return {code:output,map:null}}}],test:{include:['apps/desktop/test/cluster-machines.test.tsx'],environment:'node',maxWorkers:1,fileParallelism:false,testTimeout:15000,hookTimeout:15000}})
