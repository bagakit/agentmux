import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import base from './connector-details-modern.config.mts'
const root=resolve(import.meta.dirname,'../../..'),mutation=process.env.DELIVERY_RETRY_UI_MUTANT
const file='apps/desktop/src/renderer/src/components/ConnectorDeliveryRetryControl.tsx'
const variants={source:["const original = action === 'continue' ? retained : undefined",'const original = undefined'],qualification:['const source = delivery.retrySource',"const source = delivery.retrySource ?? { kind: 'message' as const, attempt: 1 }"]} as const
if(mutation&&!(mutation in variants))throw Error('Unknown exact-source UI mutation')
export default defineConfig({...base,cacheDir:resolve(root,'.cache/delivery-source-retry-ui'),plugins:[...base.plugins!,{name:'delivery-retry-ui-loaded',enforce:'pre',transform(original,id){
 const path=relative(root,id.split('?')[0]!)
 if(!/^(apps\/(desktop|host)|packages\/(core|connectors))\/src\/.+\.[cm]?[jt]sx?$/u.test(path))return
 let loaded=original
 if(mutation&&path===file){const [before,after]=variants[mutation as keyof typeof variants];if(original.split(before).length!==2)throw Error('Source retry mutation anchor changed');loaded=original.replace(before,after)}
 const marker=process.env.DELIVERY_RETRY_UI_LOADED,hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 if(!marker)return original===loaded?undefined:{code:loaded,map:null}
 const row=JSON.stringify({file:path,source:hash(original),loaded:hash(loaded),mutation:original===loaded?null:mutation})+'\n'
 return{code:"import {appendFileSync as __deliveryRetryUiLoaded}from'node:fs';__deliveryRetryUiLoaded("+JSON.stringify(marker)+','+JSON.stringify(row)+');\n'+loaded,map:null}
 }}],test:{...base.test,include:['apps/desktop/test/delivery-source-retry-ui.test.tsx'],testNamePattern:undefined,passWithNoTests:false,testTimeout:25_000,hookTimeout:20_000}})
