import { defineConfig } from 'vitest/config'
import owning from './selection-field.config.mts'
import { resolve, relative } from 'node:path'
import { createHash } from 'node:crypto'
const root=resolve(import.meta.dirname,'..'),report=process.env.MOTE_PRESENCE_DESKTOP_LOADED,mutation=process.env.MOTE_PRESENCE_DESKTOP_MUTANT
if(mutation&&!['renderer-main-bypass','renderer-open-bypass'].includes(mutation))throw Error('Unknown desktop Mote presence mutation')
export default defineConfig({...owning,resolve:{...owning.resolve,alias:[
 {find:/^@agentmux\/identity\/runtime-source$/,replacement:resolve(root,'../../packages/identity/dist/runtime-source.js')},
 ...owning.resolve!.alias as import('vite').Alias[]
]},plugins:[...(owning.plugins??[]),{name:'actual-desktop-presence-owner',enforce:'pre',transform(original,id){
 const path=relative(resolve(root,'../..'),id.split('?')[0]!)
 if(!['apps/desktop/src/renderer/src/lib/mote-session-recovery.ts','apps/desktop/src/renderer/src/components/MoteWorkface.tsx'].includes(path))return
 let source=original
 if(mutation==='renderer-main-bypass'&&path.endsWith('/mote-session-recovery.ts')){
  const anchor="return 'host-managed'";if(source.split(anchor).length!==2)throw Error('Expected one loaded main-role delegate');source=source.replace(anchor,"return 'ordinary'")
 }
 if(mutation==='renderer-open-bypass'&&path.endsWith('/MoteWorkface.tsx')){
  const anchor='  const scope = useMoteWorkfaceScope(workspaceId, topicId, visible)';if(source.split(anchor).length!==2)throw Error('Expected the real Mote workface scope')
  source="import { useEffect as __badMoteOpen } from 'react';\n"+source.replace(anchor,anchor+`\n  __badMoteOpen(()=>{const current=scope?.topic.quickMode?.status==='saved'?scope.topic.quickMode.defaults.conversation:null;if(!visible||!current)return;const state=useAppStore.getState(),agent=state.sessions.find(s=>s.kind==='agent'&&s.control.hostId===current.hostId&&s.control.agentSessionId===current.sessionId);if(agent?.processState!=='running'&&agent)void state.recoverSession(agent.id,undefined,{trigger:'workspace-open'});},[scope,visible])`)
 }
 if(report){const hash=(v:string)=>createHash('sha256').update(v).digest('hex'),fact={path,originalSHA256:hash(original),loadedSHA256:hash(source),...(source!==original?{mutation}:{})};source="import { appendFileSync as __moteDesktopLoaded } from 'node:fs';__moteDesktopLoaded("+JSON.stringify(report)+','+JSON.stringify(JSON.stringify(fact)+'\n')+');\n'+source}
 return source===original?undefined:{code:source,map:null}
}}],test:{...owning.test,include:['test/mote-session-recovery.test.tsx','test/mote-startup-recovery.test.ts','test/mote-startup-continuity-consumer.test.tsx'],passWithNoTests:false,fileParallelism:false,maxWorkers:1,testTimeout:30000}})
