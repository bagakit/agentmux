import assert from 'node:assert/strict'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { relative, resolve } from 'node:path'
import base from './session-continuity-core.config.mts'
const root=resolve(import.meta.dirname,'../../..'),require=createRequire(resolve(root,'apps/desktop/package.json'))
const owner='packages/core/src/ctxmux-run-adapter.ts'
const variants={
  'replace-serving-pump':{from:'if (replace && previous?.attachment && !previous.unavailable) {',to:'if (false && replace && previous?.attachment && !previous.unavailable) {',pattern:'shared observation preserves the original terminal reader'},
  'candidate-release':{from:"else await attachment.detach()\n        if (this.client !== client",to:"else { /* source mutant leaves the temporary candidate attached */ }\n        if (this.client !== client",pattern:'shared observation closes its temporary snapshot candidate'},
  'late-unavailable':{from:'if (!previous.attachment || previous.unavailable) throw previous.unavailable',to:'if (false) throw previous.unavailable',pattern:'shared observation refuses a false live handoff'}
} as const
const mutation=process.env.AGENTMUX_SHARED_HANDOFF_MUTATION as keyof typeof variants|undefined
assert.ok(!mutation||Object.hasOwn(variants,mutation),'Known shared observation mutation')
const chosen=mutation?variants[mutation]:undefined
const tracked=new Set([owner,'packages/core/src/client.ts','packages/core/src/hosted-runtime-service.ts','packages/core/src/hosted-client.ts',
  'packages/core/src/hosted-value.ts','packages/core/src/public-rpc-client.ts','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/preload/index.ts','apps/desktop/src/renderer/src/lib/api.ts','apps/desktop/src/renderer/src/components/TerminalView.tsx'])
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
export default {...base,root,cacheDir:resolve(root,'.local/cache/shared-run-observation-handoff',mutation??'baseline'),
  esbuild:{jsx:'automatic' as const},resolve:{...base.resolve,conditions:['browser','module','development|production'],alias:[
    ...['react','react/jsx-runtime','react/jsx-dev-runtime','react-dom/client'].map(id=>({find:new RegExp('^'+id+'$'),replacement:require.resolve(id)})),...base.resolve!.alias]},
  plugins:[{name:'shared-observation-loaded-source',enforce:'pre' as const,transform(source:string,id:string){
    const file=relative(root,id.split('?')[0]!);if(!tracked.has(file))return
    let loaded=source
    if(file===owner&&chosen){assert.equal(source.split(chosen.from).length-1,1,'Exact selected owner mutation anchor');loaded=source.replace(chosen.from,chosen.to)}
    if(process.env.SHARED_HANDOFF_LOADED)appendFileSync(process.env.SHARED_HANDOFF_LOADED,JSON.stringify({file,sourceSHA256:hash(source),loadedSHA256:hash(loaded),mutation:loaded===source?null:mutation})+'\n')
    return loaded===source?undefined:{code:loaded,map:null}
  }}],test:{...base.test,globalSetup:[],include:chosen?['packages/core/test/shared-run-observation-handoff.test.ts']:['packages/core/test/shared-run-observation-handoff.test.ts','apps/desktop/test/shared-run-observation-handoff.test.tsx'],
    testNamePattern:chosen?.pattern,passWithNoTests:false,fileParallelism:false,maxWorkers:1,hookTimeout:40000,testTimeout:40000}}
