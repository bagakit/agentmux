import {appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {relative,resolve} from 'node:path'
import {defineConfig} from 'vitest/config'
import original from './vitest.user-cards.config.mts'
const root=resolve(import.meta.dirname,'../../..'),mutant=process.env.RECEIVER_RECOVERY_MUTANT
const changes={
 journal:['packages/connectors/src/connection-host.ts','        if (saved) {\n          if (saved.kind !== \'receiver\'','        if (saved && false) {\n          if (saved.kind !== \'receiver\''],
 ref:['packages/connectors/src/connection-receivers.ts',"if (input.receiverRef !== null && lane.ref !== input.receiverRef) return decision('not-current')","if (false && input.receiverRef !== null && lane.ref !== input.receiverRef) return decision('not-current')"],
 route:['packages/core/src/public-rpc-service.ts','      if (isConnectionReceiverMethod(method)) {','      if (false && isConnectionReceiverMethod(method)) {']
} as const
if(mutant&&!(mutant in changes))throw Error('Unknown recovery mutation')
export default defineConfig({...original,cacheDir:resolve(root,'.cache/receiver-recovery'),plugins:[...original.plugins??[],{name:'loaded-receiver-recovery',enforce:'pre',transform(source,id){
 const file=relative(root,id.split('?')[0]!);if(!/^packages\/(core|connectors)\/src\/.+\.ts$/u.test(file))return
 let output=source;const change=mutant?changes[mutant as keyof typeof changes]:undefined
 if(change?.[0]===file){if(source.split(change[1]).length!==2)throw Error('Missing recovery mutation seam');output=source.replace(change[1],change[2])}
 if(!process.env.RECEIVER_RECOVERY_LOADED)return source===output?undefined:{code:output,map:null}
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),row=JSON.stringify({file,source:hash(source),loaded:hash(output),mutation:source===output?null:mutant})+'\n'
 return{code:"import {appendFileSync as __recoveryMark} from 'node:fs'; __recoveryMark("+JSON.stringify(process.env.RECEIVER_RECOVERY_LOADED)+','+JSON.stringify(row)+');\n'+output,map:null}
}}],test:{...original.test,include:['packages/connectors/test/receiver-recovery-consumer.test.ts'],testTimeout:20000,passWithNoTests:false}})
