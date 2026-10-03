import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'../../..')
const coreExports=(JSON.parse(readFileSync(resolve(root,'packages/core/package.json'),'utf8')) as {exports:Record<string,{import:string}>}).exports
const coreAliases=Object.entries(coreExports).sort(([a],[b])=>b.length-a.length).map(([key,value])=>({find:key==='.'?'@agentmux/core':`@agentmux/core/${key.slice(2)}`,replacement:resolve(root,'packages/core',value.import.replace('./dist/','./src/').replace(/\.js$/u,'.ts'))}))
const changes={
 'dedup-body':['apps/desktop/src/renderer/src/components/ActivityView.tsx',"placed.map(({ entry, key, from }) => {","placed.filter(({entry},index,all)=>entry.kind !== 'item' || !all.slice(0,index).some(other=>other.entry.kind === 'item' && other.entry.item.content === entry.item.content)).map(({ entry, key, from }) => {"],
 'record-resize':['packages/core/src/hosted-runtime-service.ts'," && invocation.method !== 'resizeAgent'",''],
 'lose-host-activity':['packages/core/src/hosted-runtime-service.ts',"    await recordActivity('confirmed')","    // actual mutation: completion activity omitted"],
 'lose-real-context':['packages/core/src/client.ts','if (message.systemContext) await','if (false && message.systemContext) await'],
 'human-as-system':['packages/client-ui/src/components/ConversationMessage.tsx',"const isSystemContext = speaker?.role === 'system'","const isSystemContext = speaker?.role !== 'agent'"],
 'copy-summary':['packages/client-ui/src/components/ConversationMessage.tsx',"const text = copyText ?? parts.map(partText).filter((t) => t.length > 0).join('\\n')","const text = systemSummary ?? copyText ?? parts.map(partText).filter((t) => t.length > 0).join('\\n')"],
 'generic-title':['packages/client-ui/src/components/ConversationMessage.tsx',"{recordTitle || '系统记录'}","{'Runtime context'}"]
} as const
export default defineConfig({root,cacheDir:resolve(root,'.vitest-cache/system-lines'),define:{__AGENTMUX_WEB_PREVIEW__:'true'},resolve:{conditions:['browser'],alias:coreAliases},
 plugins:[{name:'actual-system-source',enforce:'pre',transform(source,id){const file=id.split('?')[0]!;if(!file.startsWith(root+'/apps/desktop/src/')&&!file.startsWith(root+'/packages/'))return;let code=source;const name=process.env.AGENTMUX_SYSTEM_MUTATION as keyof typeof changes|undefined;if(name){const change=changes[name];assert.ok(change);if(file===resolve(root,change[0])){assert.equal(source.split(change[1]).length-1,1);code=source.replace(change[1],change[2])}}if(process.env.AGENTMUX_SYSTEM_LOADED)appendFileSync(process.env.AGENTMUX_SYSTEM_LOADED,JSON.stringify({path:relative(root,file),sourceSHA256:createHash('sha256').update(source).digest('hex'),loadedSHA256:createHash('sha256').update(code).digest('hex'),changed:code!==source})+'\n');if(code!==source)return{code,map:null}}}],
 test:{include:['apps/desktop/test/conversation-system-lines.test.tsx'],environment:'happy-dom',passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:15000}})
