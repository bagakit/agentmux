import { defineConfig } from 'vitest/config'
import { resolve,relative } from 'node:path'
import { readFileSync,existsSync,appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'../../..')
const pkg=JSON.parse(readFileSync(resolve(root,'packages/core/package.json'),'utf8'))
const aliases=Object.entries(pkg.exports).flatMap(([name,value])=>{const source=resolve(root,'packages/core/src/'+(value as {import:string}).import.replace('./dist/','').replace(/\.js$/u,'.ts'));const spec=name==='.'?'@agentmux/core':'@agentmux/core'+name.slice(1);return existsSync(source)?[{find:new RegExp('^'+spec.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'$'),replacement:source}]:[]})
const filter="item.kind === 'system_message' && item.source === 'agentmux' && item.id.startsWith('device-operation:')"
const mutations:Record<string,[string,string,string]>={
 'leak-diagnostics':['apps/desktop/src/renderer/src/components/ActivityView.tsx',filter,'false'],
 'guess-diagnostic-by-id':['apps/desktop/src/renderer/src/components/ActivityView.tsx',filter,"item.id.startsWith('device-operation:')"],
 'raw-has-items':['apps/desktop/src/renderer/src/components/ActivityView.tsx','const hasItems = unifiedItems.length > 0','const hasItems = items.length > 0'],
 'erase-host-audit':['packages/core/src/hosted-runtime-service.ts','await context.recordDeviceOperation?.(source, invocation.method, invocation.args, result, operationId)','await Promise.resolve()'],
 'duplicate-chat-audit':['packages/core/src/hosted-runtime-service.ts',"    await recordActivity('confirmed')",`    await recordActivity('confirmed')
    if (source && modifying && invocation.method === 'writeAgent') {
      const session = this.client.agentSession(String((first as {agentSessionId:string}).agentSessionId))
      await (this.client as unknown as {recordMessageAfterSideEffect(session:unknown,id:string,title:string,body:string,at:number,source:string,delivery:unknown):Promise<void>}).recordMessageAfterSideEffect(session, 'device-operation:'+operationId, '设备操作', 'writeAgent · 已提交', Date.now(), 'agentmux', {sourceDevice:source})
    }`]
}
export default defineConfig({root,define:{__AGENTMUX_WEB_PREVIEW__:'true'},esbuild:{jsx:'automatic',jsxImportSource:'react'},resolve:{conditions:['browser','import','default'],alias:[...aliases,{find:'react',replacement:resolve(root,'apps/desktop/node_modules/react')},{find:'react-dom',replacement:resolve(root,'apps/desktop/node_modules/react-dom')}]},ssr:{noExternal:['@agentmux/client-ui']},plugins:[{name:'device-chat-actual-loaded',enforce:'pre',transform(source,id){
 const path=id.split('?')[0]!;if(!path.startsWith(root+'/apps/')&&!path.startsWith(root+'/packages/'))return
 let code=source;const mutation=process.env.AGENTMUX_DEVICE_CHAT_MUTATION
 if(mutation){const change=mutations[mutation];assert.ok(change);if(path===resolve(root,change[0])){assert.equal(source.split(change[1]).length-1,1,'Unique actual loaded device operation mutation');code=source.replace(change[1],change[2])}}
 if(process.env.AGENTMUX_DEVICE_CHAT_LOADED)appendFileSync(process.env.AGENTMUX_DEVICE_CHAT_LOADED,JSON.stringify({path:relative(root,path),sourceSHA:createHash('sha256').update(source).digest('hex'),loadedSHA:createHash('sha256').update(code).digest('hex'),transformed:source!==code,mutation})+'\n')
 if(code!==source)return{code,map:null}
}}],test:{include:['apps/desktop/test/device-operation-conversation.integration.test.tsx'],environment:'happy-dom',passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:20000}})
