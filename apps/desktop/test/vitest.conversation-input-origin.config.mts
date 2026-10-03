import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
const root=resolve(import.meta.dirname,'../../..')
const changes={
 'lose-channel':['packages/client-ui/src/lib/conversation-input-source.ts',"source.kind === 'captured' ? source.channel : undefined","undefined"],
 'native-is-terminal':['packages/client-ui/src/lib/conversation-input-source.ts',"channel === undefined ? '渠道未记录' : channelLabels[channel]","channel === undefined ? 'Terminal' : channelLabels[channel]"],
 'receiver-as-sender':['packages/client-ui/src/components/ConversationInputDetails.tsx',"origin!.device?.hostId ?? '未记录'","executionHostId ?? '未记录'"],
 'lose-device-id':['packages/client-ui/src/components/ConversationInputDetails.tsx',"origin!.device?.deviceId ?? '未记录'","'未记录'"],
 'drop-current-channel':['apps/desktop/src/renderer/src/components/ActivityView.tsx',"...(entry.item.sourceChannel ? { channel: entry.item.sourceChannel } : {}), ",""],
 'lose-history-host':['apps/desktop/src/renderer/src/components/SessionHistoryView.tsx',' executionHostId={control.hostId}',''],
 'lose-focus-host':['apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx',"{...(recipient?.hostId ? { executionHostId: recipient.hostId } : {})}",""],
 'hide-other-agent-origin':['packages/client-ui/src/components/ConversationMessage.tsx','inputOrigin && !isSystemContext',"inputOrigin && !isSystemContext && speaker?.role !== 'agent'"]
}as const
export default defineConfig({root,define:{__AGENTMUX_WEB_PREVIEW__:'true'},resolve:{conditions:['browser']},plugins:[{name:'actual-input-origin-source',enforce:'pre',transform(source,id){
 const path=id.split('?')[0]!;if(!path.startsWith(root+'/apps/desktop/src/')&&!path.startsWith(root+'/packages/'))return
 let code=source;const name=process.env.AGENTMUX_INPUT_ORIGIN_MUTATION as keyof typeof changes|undefined
 if(name){const change=changes[name];assert.ok(change);if(path===resolve(root,change[0])){assert.equal(source.split(change[1]).length-1,1,'Unique actual loaded input origin mutation');code=source.replace(change[1],change[2])}}
 if(process.env.AGENTMUX_INPUT_ORIGIN_LOADED)appendFileSync(process.env.AGENTMUX_INPUT_ORIGIN_LOADED,JSON.stringify({path:relative(root,path),sourceSHA:createHash('sha256').update(source).digest('hex'),loadedSHA:createHash('sha256').update(code).digest('hex'),transformed:source!==code,mutation:name})+'\n')
 if(code!==source)return{code,map:null}
}}],test:{include:['apps/desktop/test/conversation-input-origin.test.tsx'],environment:'happy-dom',passWithNoTests:false,maxWorkers:1,fileParallelism:false,testTimeout:15000}})
