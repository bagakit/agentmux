import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './vitest.connection-api.config.mts'
const root=base.root!, marker=process.env.NATIVE_API_LOADED, mutant=process.env.NATIVE_API_MUTANT
const changes={
  serialization:['packages/connectors/src/adapters/feishu/index.ts','data: api.data as D','data: input.data'],
  isolation:['packages/connectors/src/adapters/discord/client.ts','auth: false, headers: { Authorization:','auth: true, headers: { Authorization:']
} as const
if(mutant&&!(mutant in changes))throw Error('Unknown native API adapter mutation')
export default defineConfig({...base,cacheDir:resolve(root,'.cache/connection-api-adapters'),resolve:{...base.resolve,alias:[
 {find:'@agentmux/connectors/adapters/feishu',replacement:resolve(root,'packages/connectors/src/adapters/feishu/index.ts')},...base.resolve!.alias as []
]},plugins:[{name:'actual-native-api-owner',enforce:'pre',transform(source,id){
 const path=relative(root,id.split('?')[0]!),selected=changes[mutant as keyof typeof changes]
 if(!/^packages\/(?:core|connectors)\/(?:src|test)\/.+\.ts$/u.test(path))return
 let loaded=source
 if(selected?.[0]===path){if(source.split(selected[1]).length!==2)throw Error('Native adapter mutation requires one original owner');loaded=source.replace(selected[1],selected[2])}
 if(marker){const sha=(s:string)=>createHash('sha256').update(s).digest('hex'),row=JSON.stringify({path,sourceSHA256:sha(source),loadedSHA256:sha(loaded),mutation:source===loaded?null:mutant})
  loaded="import {appendFileSync as __nativeApiLoaded} from 'node:fs'; __nativeApiLoaded("+JSON.stringify(marker)+', '+JSON.stringify(row+'\n')+');\n'+loaded}
 return loaded===source?undefined:{code:loaded,map:null}
}}],test:{...base.test,include:['packages/connectors/test/connection-api-adapters.test.ts','packages/connectors/test/feishu-client.test.ts']}})
