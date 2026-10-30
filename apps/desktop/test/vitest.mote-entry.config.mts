import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
import { createHash } from 'node:crypto'
import original from './vitest.mote-context.config.mts'
const variants = {
 'entry-retarget-foreign-source':['apps/desktop/src/renderer/src/lib/mote-main-entry.ts',' && sameMoteMainEntrySource(original.moteMainEntry, source)',''],
 'entry-reuses-completed-attach':['apps/desktop/src/renderer/src/lib/mote-main-entry.ts','JSON.stringify([entryToken,t.spaceId','JSON.stringify([t.spaceId'],
 'entry-completed-as-unknown':['packages/core/src/mote-main-entry-source.ts',"return Boolean(operation && (operation.kind === 'starting' ||\n    ['runtime-unverified', 'provider-unverified', 'operation-unconfirmed', 'original-operation-unconfirmed'].includes(operation.reason)))",'return Boolean(operation)'],
 'role-failure-spin':['apps/desktop/src/renderer/src/lib/mote-main-entry.ts',"dialogue?.issue ? { status:'unconfirmed', issue:dialogue.issue } : { status:'reading', issue:null }","{ status:'reading', issue:null }"],
 'entry-bridge-disconnect':['apps/desktop/src/main/mote-dialogue-ipc.ts',"return await options.runtime.callOriginalCore(input.target.expectedResource.hostId, method, input, { transport:'unix' })","throw new Error('Disconnected original Mote entry transport')"],
 'hide-offline-history':['apps/desktop/src/renderer/src/components/SessionPane.tsx','const canReadConversation = !pendingAgentRestore || moteHistoryReading','const canReadConversation = !pendingAgentRestore'],
 'fold-initial-loading':['apps/desktop/src/renderer/src/components/ActivityView.tsx','const moteInitialReading = moteConversation &&','const moteInitialReading = false &&'],
 'background-wake':['apps/desktop/src/renderer/src/lib/mote-main-entry.ts','const key = active && scope && target && entryToken ?','const key = scope && target ?'],
 'repeat-unknown':['apps/desktop/src/renderer/src/lib/mote-main-entry.ts','if (!inspect && !result.operation) {','if (!inspect) {'],
 'random-original-key':['apps/desktop/src/renderer/src/lib/mote-main-entry.ts',"const operationId = 'mote-entry-' + Array.from(new Uint8Array(hash),byte => byte.toString(16).padStart(2,'0')).join('')","const operationId = crypto.randomUUID()"],
 'ignore-late-input':['apps/desktop/src/renderer/src/lib/mote-main-entry.ts','original.cancelled = true','original.cancelled = false']
} as const
const name=process.env.MOTE_ENTRY_MUTATION as keyof typeof variants|undefined
if(name&&!variants[name])throw Error('Unknown exact Mote entry mutation')
export default defineConfig({...original,plugins:[{name:'mote-entry-loaded-proof',enforce:'pre',transform(source,id){
 const path=relative(original.root!,id.split('?')[0]!);if(!(path.startsWith('apps/desktop/src/')||process.env.MOTE_ENTRY_CONSUMER&&(path.startsWith('packages/core/src/')||path.startsWith('apps/host/src/')))||!path.endsWith('.tsx')&&!path.endsWith('.ts'))return
 let loaded=source;const selected=name&&variants[name]
 if(selected&&path===selected[0]){if(source.split(selected[1]).length!==2)throw Error('Exact entry source mutation missing or nonunique');loaded=source.replace(selected[1],selected[2])}
 if(process.env.MOTE_ENTRY_LOADED){const hash=(s:string)=>createHash('sha256').update(s).digest('hex'),entry=JSON.stringify({path,originalSHA256:hash(source),loadedSHA256:hash(loaded),...(loaded!==source?{mutation:name}:{})})+'\n';loaded="import {appendFileSync as __entryLoaded} from 'node:fs';\n__entryLoaded("+JSON.stringify(process.env.MOTE_ENTRY_LOADED)+','+JSON.stringify(entry)+');\n'+loaded}
 if(loaded!==source)return{code:loaded,map:null}
}},...(original.plugins??[])],test:{...original.test,include:process.env.MOTE_ENTRY_CONSUMER?['apps/desktop/test/mote-entry-consumer.test.tsx']:['apps/desktop/test/mote-main-entry.test.tsx'],testTimeout:15000}})
