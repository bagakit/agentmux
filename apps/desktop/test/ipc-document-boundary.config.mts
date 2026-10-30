import assert from 'node:assert/strict'
import {appendFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {relative,resolve} from 'node:path'
import base from './capsule-settings.config.mts'
import {domainTests} from '../scripts/fixtures/ipc-document-boundary/consumers.mjs'
import {variants,transform} from '../scripts/fixtures/ipc-document-boundary/variants.mjs'
const root=resolve(import.meta.dirname,'../../..'), mutation=process.env.IPC_DOCUMENT_MUTATION
assert.ok(!mutation || Object.hasOwn(variants,mutation),'Known original-source mutation')
const chosen=mutation ? variants[mutation] : undefined
const digest=(value:string)=>createHash('sha256').update(value).digest('hex')

export default {...base, root, define:{...base.define,__AGENTMUX_WEB_PREVIEW__:process.env.IPC_DOCUMENT_TARGET==='capsule-client'?'false':'true'}, cacheDir:process.env.IPC_DOCUMENT_CACHE,
 plugins:[...base.plugins,{name:'ipc-boundary-original-source',enforce:'pre' as const,
 transform(code:string,id:string){const file=relative(root,id.split('?')[0]!)
   if(!file.startsWith('apps/desktop/src/main/'))return
   const loaded=transform(code,file,chosen)
   if(process.env.IPC_DOCUMENT_LOADED)appendFileSync(process.env.IPC_DOCUMENT_LOADED,
     JSON.stringify({file,original:digest(code),loaded:digest(loaded)})+'\n')
   return loaded===code ? undefined : {code:loaded,map:null}
 }}],
 test:{...base.test,include:process.env.IPC_DOCUMENT_TARGET==='capsule-client' ? ['apps/desktop/test/capsule-client.test.ts'] : process.env.IPC_DOCUMENT_TARGET==='all' ? [...domainTests,'apps/desktop/test/ipc-document-boundary.test.ts'] : ['apps/desktop/test/ipc-document-boundary.test.ts'],
 testNamePattern:process.env.IPC_DOCUMENT_PATTERN || undefined,
 testTimeout:30000,hookTimeout:30000,fileParallelism:false,maxWorkers:1}}
